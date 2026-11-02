import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Autoriser uniquement les méthodes utilisées par l'application.
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');

    return res.status(405).json({
      error: 'Méthode non autorisée. Utilise GET ou POST.'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    return res.status(500).json({
      error:
        "La variable GEMINI_API_KEY n'est pas configurée. Ajoute-la dans l'environnement utilisé, puis redémarre le serveur local ou redéploie le projet."
    });
  }

  const model =
    process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';

  const now = new Date();

  const dateStr = now.toLocaleDateString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const timeStr = now.toLocaleTimeString('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const prompt = `
Tu es un assistant d'analyse de football.

Date actuelle : ${dateStr}.
Heure actuelle : ${timeStr}.
Fuseau horaire de référence : Europe/Paris.

MISSION :
Utilise Google Search pour rechercher et vérifier les matchs
de football prévus aujourd'hui et qui n'ont pas encore commencé.

RÈGLES :
1. Vérifie la date, la compétition et l'horaire de chaque rencontre.
2. Ne propose aucun match d'une autre date.
3. Ne propose aucun match déjà commencé, terminé, annulé ou reporté.
4. Fournis au maximum 3 matchs.
5. Tu peux fournir moins de 3 matchs.
6. Si aucun match ne peut être confirmé, renvoie [].
7. Ne fabrique aucune rencontre, statistique, blessure ou composition.
8. Ne fabrique aucune cote.
9. Utilise null pour odds si aucune cote actuelle n'est vérifiée.
10. Utilise toujours "Non évaluée" pour confidence.
11. Dans tip, distingue les informations vérifiées des hypothèses.
12. Si tu indiques une cote, mentionne son fournisseur et les limites
    de sa fraîcheur dans tip.
13. Les sélections sont des pistes d'analyse et non des gains garantis.
14. Réponds uniquement avec un tableau JSON valide.
15. N'ajoute aucun texte ni bloc Markdown autour du JSON.

STRUCTURE ATTENDUE :
[
  {
    "league": "Nom de la compétition",
    "match": "Équipe domicile vs Équipe extérieure",
    "time": "HH:MM (heure de Paris)",
    "tip": "Analyse courte en français avec les limites des informations.",
    "selection": "Sélection proposée",
    "odds": null,
    "confidence": "Non évaluée"
  }
]
`;

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        tools: [
          {
            googleSearch: {}
          }
        ],
        maxOutputTokens: 8192
      }
    });

    const candidate = response.candidates?.[0];
    const grounding = candidate?.groundingMetadata;

    // Diagnostic dans le terminal local ou les journaux Vercel.
    // Cet horodatage n'est pas la date de mise à jour des données.
    console.log(
      '[pronos] Recherche Google',
      JSON.stringify({
        model,
        responseReceivedAt: new Date().toISOString(),
        finishReason: candidate?.finishReason || null,
        queries: grounding?.webSearchQueries || [],
        sources: (grounding?.groundingChunks || [])
          .filter(chunk => chunk.web)
          .map(chunk => ({
            title: chunk.web.title,
            url: chunk.web.uri
          }))
      })
    );

    if (candidate?.finishReason === 'MAX_TOKENS') {
      return res.status(502).json({
        error:
          "La réponse de Gemini a été interrompue avant la fin. Réduis le nombre de matchs demandé ou augmente la limite de sortie."
      });
    }

    // Avec @google/genai : response.text, et non response.text().
    const rawText =
      typeof response.text === 'string'
        ? response.text.trim()
        : '';

    if (!rawText) {
      return res.status(502).json({
        error: "Gemini n'a renvoyé aucun texte exploitable.",
        reason:
          response.promptFeedback?.blockReason ||
          candidate?.finishReason ||
          'UNKNOWN'
      });
    }

    let parsed;

    try {
      parsed = extractJsonArray(rawText);
    } catch (error) {
      console.error('[pronos] JSON invalide', {
        message: error.message,
        finishReason: candidate?.finishReason
      });

      return res.status(502).json({
        error:
          "Gemini a répondu, mais le résultat n'est pas un tableau JSON valide. Réessaie."
      });
    }

    // Ne pas masquer une réponse mal formée comme une liste vide.
    if (
      parsed.some(item =>
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        typeof item.match !== 'string' ||
        !item.match.trim() ||
        typeof item.selection !== 'string' ||
        !item.selection.trim()
      )
    ) {
      return res.status(502).json({
        error:
          "La réponse de Gemini contient des matchs incomplets ou mal formatés. Réessaie."
      });
    }

    const matches = parsed.slice(0, 3).map(item => ({
      league: getText(item.league, 'Football'),
      match: item.match.trim(),
      time: getText(item.time, 'Horaire non confirmé'),
      tip: getText(item.tip, 'Analyse non disponible.'),
      selection: item.selection.trim(),
      odds: normalizeOdds(item.odds),
      confidence: 'Non évaluée'
    }));

    // IMPORTANT : le HTML attend directement un tableau.
    return res.status(200).json(matches);
  } catch (error) {
    console.error('[pronos] Erreur Gemini', {
      name: error?.name,
      status: error?.status,
      message: error?.message
    });

    const upstreamStatus = Number(error?.status);

    const status =
      Number.isInteger(upstreamStatus) &&
      upstreamStatus >= 400 &&
      upstreamStatus <= 599
        ? upstreamStatus
        : 500;

    return res.status(status).json({
      error: getErrorMessage(status)
    });
  }
}

function getText(value, fallback) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

function normalizeOdds(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }

  if (typeof value === 'string' && !value.trim()) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) && number > 1
    ? number
    : null;
}

function extractJsonArray(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');

    if (start === -1 || end <= start) {
      throw new Error('Aucun tableau JSON trouvé.');
    }

    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }

  if (!Array.isArray(parsed)) {
    throw new Error('La réponse doit être un tableau JSON.');
  }

  return parsed;
}

function getErrorMessage(status) {
  switch (status) {
    case 400:
      return (
        'Gemini a refusé les paramètres de la requête. ' +
        'Consulte les journaux pour le détail.'
      );

    case 401:
    case 403:
      return (
        "Accès Gemini refusé. Vérifie la clé API, ses restrictions " +
        "et les autorisations du projet."
      );

    case 404:
      return (
        "Le modèle ou la ressource demandé est introuvable. " +
        "Vérifie GEMINI_MODEL et l'accès du projet à ce modèle."
      );

    case 429:
      return (
        "Limite de requêtes ou quota Gemini atteint. " +
        "Vérifie les quotas et la facturation, puis réessaie."
      );

    default:
      return (
        "Impossible de récupérer les analyses auprès de Gemini. " +
        "Consulte le terminal local ou les journaux Vercel."
      );
  }
}
