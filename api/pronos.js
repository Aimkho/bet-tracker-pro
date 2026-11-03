import { GoogleGenAI } from '@google/genai';

// Durée maximale demandée à Vercel.
// La limite effective dépend de la configuration de ton projet.
export const config = {
  maxDuration: 120
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Le HTML envoie une requête POST avec le jeton Supabase.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');

    return res.status(405).json({
      error: 'Méthode non autorisée. Utilise GET ou POST.'
    });
  }

  // CONFIGURATION SERVEUR

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  const supabaseUrl = process.env.SUPABASE_URL
    ?.trim()
    .replace(/\/+$/, '');

  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY?.trim();

  const model =
    process.env.GEMINI_MODEL?.trim() ||
    'gemini-3.8-flash';

  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    console.error('[pronos] Variables manquantes', {
      GEMINI_API_KEY: Boolean(apiKey),
      SUPABASE_URL: Boolean(supabaseUrl),
      SUPABASE_ANON_KEY: Boolean(supabaseAnonKey)
    });

    return res.status(500).json({
      error:
        'Configuration serveur incomplète. Vérifie GEMINI_API_KEY, ' +
        'SUPABASE_URL et SUPABASE_ANON_KEY dans Vercel, puis redéploie.'
    });
  }

  try {
    const url = new URL(supabaseUrl);

    if (url.protocol !== 'https:') {
      throw new Error('HTTPS requis.');
    }
  } catch {
    return res.status(500).json({
      error:
        'SUPABASE_URL est invalide. Utilise l’URL HTTPS de ton projet Supabase.'
    });
  }

  // VÉRIFICATION DU JETON FOURNI PAR LE HTML

  const authorization = req.headers.authorization;

  if (
    typeof authorization !== 'string' ||
    !/^Bearer\s+\S+$/i.test(authorization)
  ) {
    return res.status(401).json({
      error: 'Connecte-toi pour utiliser l’assistant IA.'
    });
  }

  try {
    // Vérification auprès de Supabase :
    // on ne se contente pas de décoder le jeton dans le navigateur.
    const authResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        method: 'GET',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: authorization,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!authResponse.ok) {
      if (authResponse.status === 429) {
        return res.status(429).json({
          error:
            'Le service d’authentification reçoit trop de demandes. ' +
            'Réessaie dans un moment.'
        });
      }

      if (authResponse.status >= 500) {
        return res.status(503).json({
          error:
            'Le service de vérification de session est temporairement indisponible.'
        });
      }

      return res.status(401).json({
        error:
          'Session invalide ou expirée. Déconnecte-toi, puis reconnecte-toi.'
      });
    }

    const user = await authResponse.json();

    if (!user?.id) {
      return res.status(401).json({
        error: 'Aucune session utilisateur valide.'
      });
    }

    // DATE ET HEURE DE RÉFÉRENCE

    const now = new Date();

    const dateISO = getParisDate(now);

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

    // CONSIGNES DONNÉES À GEMINI

    const prompt = `
Tu es un assistant d'analyse de football.
Tu fournis des pistes d'analyse, pas des garanties de gain.

DATE ACTUELLE :
${dateStr}, soit ${dateISO}.

HEURE ACTUELLE :
${timeStr}, fuseau Europe/Paris.

MISSION :
Utilise Google Search pour rechercher 6 à 8 rencontres de football
différentes prévues aujourd'hui et qui n'ont pas encore commencé.

Explore plusieurs compétitions et plusieurs pays si le calendrier
et la qualité des informations disponibles le permettent.
Ne te limite pas automatiquement aux championnats les plus connus.

VÉRIFICATION DES RENCONTRES :
- Vérifie la date, la compétition et l'horaire de chaque match.
- Utilise le fuseau Europe/Paris pour les horaires affichés.
- Exclue les matchs commencés, terminés, annulés ou reportés.
- Ne propose aucun match d'une autre date.
- Ne présente pas un horaire ancien ou incertain comme confirmé.
- Une seule proposition par rencontre.
- Ne complète jamais la liste avec des rencontres inventées.
- Ne répète pas une rencontre avec des variantes de sélection.
- Si seulement 1 à 5 matchs peuvent être confirmés, renvoie ces matchs.
- Si aucun match ne peut être confirmé, renvoie [].

ANALYSE DES SÉLECTIONS :
- Compare les marchés pertinents pour chaque rencontre.
- Ne privilégie pas automatiquement la victoire d'un favori.
- Explique précisément la condition nécessaire pour gagner.
- Distingue les buts du match des buts d'une seule équipe.
- Précise le périmètre du marché, notamment le temps réglementaire
  lorsqu'il est applicable.
- Base les arguments sur des faits récents réellement trouvés.
- Explique au moins un facteur pouvant faire échouer la sélection.
- Ne fabrique aucun résultat récent, statistique, classement,
  joueur absent ou composition.
- Si les informations sont limitées, indique cette limite dans tip.
- Ne présente aucune sélection comme sûre, garantie ou sans risque.
- N'affirme pas que ces propositions maximisent les chances de gagner.
- Un favori ou une cote élevée ne suffit pas à établir un pari avantageux.
- Ne prétends pas identifier une opportunité de valeur sans une
  estimation de probabilité indépendante et étayée.

COTES ET CONFIANCE :
- Cette application ne dispose pas ici d'un flux de cotes de bookmaker.
- Renvoie toujours null pour odds.
- N'invente aucune cote et ne donne aucune cote estimée.
- L'utilisateur renseignera la cote vérifiée chez son bookmaker.
- Renvoie toujours "Non évaluée" pour confidence.
- N'invente aucun pourcentage de réussite.

COMBINÉS :
- Renvoie uniquement les sélections individuelles dans ce tableau.
- L'application permet à l'utilisateur de préparer son propre combiné.
- Ne présente aucun regroupement de matchs comme plus sûr.
- N'ajoute pas une sélection uniquement pour augmenter une cote totale.

FORMAT DE SORTIE :
Réponds uniquement avec un tableau JSON valide.
N'ajoute ni texte avant ou après, ni bloc Markdown.
Le tableau doit contenir au maximum 8 objets.

Structure de chaque objet :
[
  {
    "date": "${dateISO}",
    "league": "Nom exact de la compétition",
    "match": "Équipe domicile vs Équipe extérieure",
    "time": "HH:MM (heure de Paris)",
    "selection": "Marché exact proposé",
    "tip": "Faits vérifiés, condition de gain, risque principal et limites.",
    "odds": null,
    "confidence": "Non évaluée"
  }
]
`;

    // APPEL À GEMINI AVEC GOOGLE SEARCH

    const ai = new GoogleGenAI({
      apiKey
    });

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        tools: [
          {
            googleSearch: {}
          }
        ],
        maxOutputTokens: 16384,
        httpOptions: {
          timeout: 95000
        }
      }
    });

    const candidate = response.candidates?.[0];
    const grounding = candidate?.groundingMetadata;

    // Sources retournées par l'outil de recherche,
    // et non liens inventés dans le texte du modèle.
    const searchSources = extractSearchSources(grounding);

    console.log(
      '[pronos] Résultat Gemini',
      JSON.stringify({
        responseReceivedAt: new Date().toISOString(),
        model,
        finishReason: candidate?.finishReason || null,
        searchQueries: grounding?.webSearchQueries || [],
        sources: searchSources
      })
    );

    // RÉPONSE INTERROMPUE

    if (candidate?.finishReason === 'MAX_TOKENS') {
      return res.status(502).json({
        error:
          'La réponse de Gemini a été interrompue avant la fin. Réessaie.'
      });
    }

    // Avec @google/genai, text est une propriété.
    const rawText =
      typeof response.text === 'string'
        ? response.text.trim()
        : '';

    if (!rawText) {
      console.warn('[pronos] Réponse vide', {
        finishReason: candidate?.finishReason,
        blockReason: response.promptFeedback?.blockReason
      });

      return res.status(502).json({
        error:
          'Gemini n’a renvoyé aucun texte exploitable. Réessaie.'
      });
    }

    // LECTURE DU JSON

    let parsed;

    try {
      parsed = parseJsonArray(rawText);
    } catch (error) {
      console.warn('[pronos] JSON invalide', {
        message: error.message
      });

      return res.status(502).json({
        error:
          'Gemini a répondu, mais le résultat n’est pas un tableau JSON valide. Réessaie.'
      });
    }

    // Sans source exploitable, ne pas afficher des propositions
    // comme si elles étaient documentées.
    // L'absence de métadonnées ne prouve toutefois pas qu'aucune
    // recherche n'a eu lieu.
    if (parsed.length > 0 && searchSources.length === 0) {
      return res.status(502).json({
        error:
          'Aucune source de recherche exploitable n’a été retournée. ' +
          'Les propositions ne sont pas affichées ; réessaie.'
      });
    }

    // NETTOYAGE ET FORMAT ATTENDU PAR LE HTML

    const matches = [];
    const seenMatches = new Set();
    const responseReceivedAt = new Date().toISOString();

    for (const item of parsed) {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item)
      ) {
        continue;
      }

      const match = cleanText(item.match);
      const selection = cleanText(item.selection);

      // Contrôle de la date déclarée par le modèle.
      if (
        item.date !== dateISO ||
        !match ||
        !selection
      ) {
        continue;
      }

      const matchKey = match
        .toLocaleLowerCase('fr-FR')
        .replace(/\s+/g, ' ');

      if (seenMatches.has(matchKey)) {
        continue;
      }

      seenMatches.add(matchKey);

      matches.push({
        date: dateISO,
        league:
          cleanText(item.league) || 'Football',
        match,
        time:
          cleanText(item.time) || 'Horaire à vérifier',
        selection,
        tip:
          cleanText(item.tip) ||
          'Informations insuffisantes pour détailler cette sélection.',
        odds: null,
        confidence: 'Non évaluée',
        searchSources,
        responseReceivedAt
      });

      if (matches.length === 8) {
        break;
      }
    }

    /*
     * Ces contrôles vérifient le format, les doublons et la date
     * déclarée. Ils ne valident pas indépendamment l'existence
     * des rencontres ni l'exactitude des analyses.
     *
     * Pour une validation indépendante, il faut raccorder
     * une source structurée de données sportives.
     */

    // IMPORTANT :
    // Le HTML attend directement un tableau, pas { matches: [...] }.
    return res.status(200).json(matches);

  } catch (error) {
    console.error('[pronos] Erreur serveur', {
      name: error?.name,
      status: error?.status,
      message: error?.message
    });

    if (
      error?.name === 'TimeoutError' ||
      error?.name === 'AbortError'
    ) {
      return res.status(504).json({
        error:
          'Le service a mis trop de temps à répondre. Réessaie dans un moment.'
      });
    }

    const status = Number(error?.status);

    if (status === 429) {
      return res.status(429).json({
        error:
          'Quota ou limite de requêtes Gemini atteint. ' +
          'Réessaie plus tard et vérifie les quotas ainsi que la facturation.'
      });
    }

    if (status === 404) {
      return res.status(502).json({
        error:
          'Le modèle Gemini demandé est introuvable ou indisponible. ' +
          'Vérifie GEMINI_MODEL et les journaux Vercel.'
      });
    }

    if (status === 401 || status === 403) {
      return res.status(502).json({
        error:
          'Accès Google refusé. Vérifie la clé Gemini, ' +
          'ses restrictions et les autorisations du projet.'
      });
    }

    if (status === 400) {
      return res.status(502).json({
        error:
          'Gemini a refusé les paramètres de la requête. ' +
          'Consulte les journaux Vercel pour identifier le paramètre concerné.'
      });
    }

    return res.status(502).json({
      error:
        'Impossible de récupérer les analyses. ' +
        'Consulte les journaux Vercel pour le détail.'
    });
  }
}

// FONCTIONS UTILITAIRES

function cleanText(value) {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

function isWebUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);

    return ['https:', 'http:'].includes(
      url.protocol
    );
  } catch {
    return false;
  }
}

function extractSearchSources(grounding) {
  const sources = [];
  const seen = new Set();

  for (const chunk of grounding?.groundingChunks || []) {
    const web = chunk.web;

    if (
      !web?.uri ||
      !isWebUrl(web.uri) ||
      seen.has(web.uri)
    ) {
      continue;
    }

    seen.add(web.uri);

    sources.push({
      title:
        cleanText(web.title) || 'Source de recherche',
      url: web.uri
    });
  }

  return sources;
}

function getParisDate(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [
      part.type,
      part.value
    ])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function parseJsonArray(text) {
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
      throw new Error(
        'Aucun tableau JSON trouvé.'
      );
    }

    parsed = JSON.parse(
      cleaned.slice(start, end + 1)
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      'La réponse doit être un tableau JSON.'
    );
  }

  return parsed;
}
