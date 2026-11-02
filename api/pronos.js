export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "La variable d'environnement GEMINI_API_KEY est introuvable sur Vercel. Ajoute-la dans Settings > Environment Variables, puis fais un Redeploy."
    });
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const systemPrompt = `Tu es un assistant spécialisé en analyse de matchs de football.
Utilise les informations de recherche Google disponibles pour identifier des matchs réels prévus aujourd'hui : ${dateStr}.

Règles importantes :
- Ne invente pas de match.
- Si tu ne trouves pas assez d'informations fiables, renvoie moins de pronostics.
- Analyse uniquement le football.
- Donne entre 1 et 4 pronostics.
- Les cotes doivent être réalistes et exprimées en format décimal, par exemple 1.85.
- Le champ confidence doit être une chaîne comme "70%".
- Réponds uniquement avec un tableau JSON valide, sans texte avant ou après.

Format attendu :
[
  {
    "type": "GOALS" ou "WINNER",
    "league": "Nom de la compétition",
    "match": "Équipe A vs Équipe B",
    "time": "Heure du match",
    "selection": "Pari conseillé",
    "odds": 1.85,
    "confidence": "70%",
    "tip": "Analyse courte basée sur la forme récente, les absences et l'enjeu du match."
  }
]`;

  try {
    const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';

const apiUrl =
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim()
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Recherche les matchs de football importants prévus aujourd'hui, le ${dateStr}. Donne-moi 1 à 4 pronostics réels au format JSON strict.`
              }
            ]
          }
        ],
        tools: [
          {
            google_search: {}
          }
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 2048
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const apiMessage =
        data?.error?.message ||
        `Erreur Gemini HTTP ${response.status}`;

      return res.status(response.status).json({
        error: apiMessage
      });
    }

    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const rawText = parts
      .map(part => part?.text || '')
      .join('')
      .trim();

    if (!rawText) {
      const blockReason =
        candidate?.finishReason ||
        data?.promptFeedback?.blockReason ||
        'Raison inconnue';

      return res.status(502).json({
        error: `Gemini n'a renvoyé aucun texte exploitable. Motif : ${blockReason}.`
      });
    }

    const parsed = extractJsonArray(rawText);

    if (!parsed) {
      return res.status(502).json({
        error: "Gemini a répondu, mais sa réponse n'a pas pu être convertie en JSON.",
        rawResponse: rawText.slice(0, 800)
      });
    }

    const cleaned = parsed
      .filter(item => item && item.match && item.selection)
      .map(item => ({
        type: item.type || 'WINNER',
        league: item.league || 'Football',
        match: String(item.match),
        time: item.time || "Aujourd'hui",
        selection: String(item.selection),
        odds: Number(item.odds) || 0,
        confidence: item.confidence || '70%',
        tip: item.tip || ''
      }));

    if (cleaned.length === 0) {
      return res.status(200).json([]);
    }

    return res.status(200).json(cleaned);

  } catch (error) {
    return res.status(500).json({
      error: 'Erreur serveur interne : ' + error.message
    });
  }
}

function extractJsonArray(text) {
  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
    if (Array.isArray(direct?.pronostics)) return direct.pronostics;
    if (Array.isArray(direct?.suggestions)) return direct.suggestions;
    if (Array.isArray(direct?.matches)) return direct.matches;
  } catch (_) {
    // On continue avec l'extraction par regex
  }

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}
