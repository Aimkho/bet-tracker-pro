export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(400).json({ 
            error: "La variable d'environnement GEMINI_API_KEY est introuvable sur Vercel. Veuillez l'ajouter dans vos paramètres Vercel puis faire un Redeploy." 
        });
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const systemPrompt = `Tu es un expert en pronostics sportifs doté d'une connexion internet en direct. Analyse les matchs de football prévus aujourd'hui (${dateStr}).
Fournis une liste de 3 à 4 pronostics réels du jour sous la forme STRICTE d'un tableau JSON pur (sans texte additionnel, sans markdown autour si possible, ou uniquement dans un bloc json) avec les champs suivants :
[
  {
    "type": "GOALS" ou "WINNER",
    "league": "Nom de la compétition",
    "match": "Équipe A vs Équipe B",
    "time": "Heure du match",
    "selection": "Pari conseillé",
    "odds": 1.75,
    "confidence": "85%",
    "tip": "Analyse courte et précise basée sur la forme récente."
  }
]`;

    try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey.trim()}`;
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Donne-moi les pronostics réels du jour au format JSON." }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({ 
                error: data.error?.message || "Erreur renvoyée par l'API Google Gemini." 
            });
        }

        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
            return res.status(500).json({ error: "L'IA Gemini a renvoyé une réponse vide." });
        }

        // Extraction propre du JSON depuis la réponse de Gemini
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            return res.status(500).json({ error: "Impossible de formater la réponse de Gemini en JSON." });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        return res.status(200).json(parsed);

    } catch (error) {
        return res.status(500).json({ error: "Erreur serveur interne : " + error.message });
    }
}
