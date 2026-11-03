import { GoogleGenAI } from '@google/genai';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Utilise GET ou POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';

  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({
      error: 'Configuration serveur incomplète : vérifie GEMINI_API_KEY, SUPABASE_URL et SUPABASE_ANON_KEY dans Vercel.'
    });
  }

  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) {
    return res.status(401).json({ error: 'Connecte-toi pour utiliser l’assistant.' });
  }

  try {
    // Vérification serveur de la session : ne pas se fier au seul HTML.
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: authorization },
      signal: AbortSignal.timeout(12000)
    });

    if (!authResponse.ok) {
      return res.status(authResponse.status >= 500 ? 503 : 401).json({
        error: authResponse.status >= 500
          ? 'Le service de vérification de session est indisponible.'
          : 'Session invalide ou expirée. Reconnecte-toi.'
      });
    }

    const user = await authResponse.json();
    if (!user?.id) {
      return res.status(401).json({ error: 'Session utilisateur invalide.' });
    }

    const now = new Date();
    const dateISO = parisDate(now);
    const dateStr = now.toLocaleDateString('fr-FR', {
      timeZone: 'Europe/Paris', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('fr-FR', {
      timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false
    });

    const prompt = `
Tu es un assistant d'analyse de football. Tu ne garantis aucun résultat.
Date actuelle : ${dateStr}, soit ${dateISO}.
Heure actuelle : ${timeStr}, fuseau Europe/Paris.

Utilise Google Search pour rechercher 6 à 8 RENCONTRES DIFFÉRENTES
prévues aujourd'hui et qui n'ont pas encore commencé.
Explore plusieurs compétitions si le calendrier et les sources le permettent.

VÉRIFICATION :
- Vérifie la date, la compétition et l'horaire de chaque rencontre.
- Exclue les matchs commencés, terminés, annulés ou reportés.
- Ne complète jamais la liste avec des matchs inventés, d'une autre date
  ou plusieurs propositions concernant une même rencontre.
- Si moins de 6 matchs peuvent être confirmés, renvoie moins de 6 matchs.
- Si aucun match ne peut être confirmé, renvoie [].

ANALYSE :
- Une seule sélection par rencontre.
- Compare les marchés pertinents, sans privilégier automatiquement une victoire.
- Décris précisément la condition de gain et le périmètre du marché
  (temps réglementaire, buts du match ou buts d'une équipe, etc.).
- Appuie les arguments sur des faits récents effectivement trouvés.
- Explique un facteur pouvant faire échouer chaque sélection.
- Ne fabrique ni résultats récents, ni statistiques, ni absences.
- Un favori ou une cote élevée ne suffit pas à établir une opportunité de valeur.
- Ne promets pas que cette liste maximise les chances de gagner.
- Ne calcule aucune probabilité de réussite non étayée.

COTES :
- La recherche Web ne constitue pas un flux de cotes de bookmaker.
- Pour cette version, renvoie toujours null pour odds.
- L'utilisateur renseignera une cote vérifiée chez son bookmaker dans l'application.
- Renvoie toujours "Non évaluée" pour confidence.

FORMAT : uniquement un tableau JSON valide, sans Markdown, avec au maximum 8 objets :
[
  {
    "date": "${dateISO}",
    "league": "Nom de la compétition",
    "match": "Équipe domicile vs Équipe extérieure",
    "time": "HH:MM (heure de Paris)",
    "selection": "Marché exact proposé",
    "tip": "Faits vérifiés, condition de gain, risque principal et limites.",
    "odds": null,
    "confidence": "Non évaluée"
  }
]
`;

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 16384,
        httpOptions: { timeout: 95000 }
      }
    });

    const candidate = response.candidates?.[0];
    const grounding = candidate?.groundingMetadata;
    const sources = [];
    const seenUrls = new Set();

    for (const chunk of grounding?.groundingChunks || []) {
      const web = chunk.web;
      if (!web?.uri || !isWebUrl(web.uri) || seenUrls.has(web.uri)) continue;
      seenUrls.add(web.uri);
      sources.push({ title: web.title || 'Source', url: web.uri });
    }

    console.log('[pronos]', JSON.stringify({
      receivedAt: new Date().toISOString(),
      model,
      finishReason: candidate?.finishReason,
      searchQueries: grounding?.webSearchQueries || [],
      sources
    }));

    if (candidate?.finishReason === 'MAX_TOKENS') {
      return res.status(502).json({ error: 'La réponse Gemini a été interrompue avant la fin. Réessaie.' });
    }

    const raw = typeof response.text === 'string' ? response.text.trim() : '';
    if (!raw) {
      return res.status(502).json({ error: 'Gemini n’a renvoyé aucun texte exploitable.' });
    }

    let parsed;
    try {
      parsed = parseArray(raw);
    } catch {
      return res.status(502).json({ error: 'Gemini n’a pas renvoyé un tableau JSON valide. Réessaie.' });
    }

    // Sans sources retournées, ne pas présenter les propositions comme documentées.
    // L'absence de métadonnées ne prouve pas qu'aucune recherche n'a eu lieu.
    if (parsed.length && !sources.length) {
      return res.status(502).json({
        error: 'Aucune source de recherche exploitable n’a été retournée. Les propositions ne sont pas affichées ; réessaie.'
      });
    }

    const seenMatches = new Set();
    const matches = [];
    const checkedAt = new Date().toISOString();

    for (const item of parsed) {
      if (!item || item.date !== dateISO || !cleanText(item.match) || !cleanText(item.selection)) continue;
      const matchKey = item.match.trim().toLocaleLowerCase('fr-FR').replace(/\s+/g, ' ');
      if (seenMatches.has(matchKey)) continue;
      seenMatches.add(matchKey);
      matches.push({
        date: dateISO,
        league: cleanText(item.league) || 'Football',
        match: item.match.trim(),
        time: cleanText(item.time) || 'Horaire à vérifier',
        selection: item.selection.trim(),
        tip: cleanText(item.tip) || 'Informations insuffisantes pour détailler cette sélection.',
        odds: null,
        confidence: 'Non évaluée',
        searchSources: sources,
        responseReceivedAt: checkedAt
      });
      if (matches.length === 8) break;
    }

    // Le contrôle ci-dessus vérifie le format et les dates déclarées,
    // pas indépendamment la vérité des rencontres et des horaires.
    return res.status(200).json(matches);
  } catch (error) {
    console.error('[pronos] Erreur', {
      name: error?.name, status: error?.status, message: error?.message
    });

    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return res.status(504).json({ error: 'Le service a mis trop de temps à répondre. Réessaie.' });
    }

    const status = Number(error?.status);
    if (status === 429) {
      return res.status(429).json({ error: 'Quota ou limite de requêtes Gemini atteint. Réessaie plus tard et vérifie ta facturation.' });
    }
    if (status === 404) {
      return res.status(502).json({ error: 'Le modèle Gemini demandé est introuvable ou indisponible. Vérifie GEMINI_MODEL et les journaux Vercel.' });
    }
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'Accès Google refusé. Vérifie la clé Gemini, ses restrictions et les autorisations du projet.' });
    }
    return res.status(502).json({ error: 'Impossible de récupérer les analyses. Consulte les journaux Vercel pour le détail.' });
  }
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isWebUrl(value) {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function parisDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseArray(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let result;
  try { result = JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf('['), end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('Tableau introuvable');
    result = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (!Array.isArray(result)) throw new Error('Tableau attendu');
  return result;
}
