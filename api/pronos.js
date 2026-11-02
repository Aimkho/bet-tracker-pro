export default async function handler(req, res) {
    // Permettre l'accès CORS
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
        return res.status(500).json({ 
            error: "La clé GEMINI_API_KEY n'est pas configurée dans les variables d'environnement Vercel. Pensez à ajouter GEMINI_API_KEY puis à cliquer sur 'Redeploy'." 
        });
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false });

    const systemPrompt = `Tu es un expert en pronostics sportifs. Recherche sur le Web les matchs réels de Football ou Tennis prévus AUJOURD'HUI (${dateStr}) avec un coup d'envoi APRÈS ${timeStr}.
Examine les statistiques H2H et la forme récente des deux équipes.
Tu dois répondre UNIQUEMENT avec un tableau JSON valide. Aucun texte avant, aucun texte après, aucune balise markdown.

Exemple de réponse attendue :
[
  {
    "type": "GOALS",
    "league": "Premier League",
    "match": "Équipe A vs Équipe B",
    "time": "21:00",
    "selection": "Plus de 2.5 Buts",
    "odds": 1.75,
    "confidence": "85%",
    "tip": "Forme offensive élevée et 4 des 5 derniers affrontements H2H ont dépassé 2.5 buts."
  }
]`;

    const userQuery = `Trouve 3 à 5 matchs réels d'aujourd'hui (${dateStr}) joués après ${timeStr}. Analyse H2H et cotes. Format JSON pur uniquement.`;

    try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: userQuery }] }],
                tools: [{ "google_search": {} }],
                systemInstruction: { parts: [{ text: systemPrompt }] }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("Gemini API Error:", errText);
            return res.status(response.status).json({ error: "Erreur API Gemini", details: errText });
        }

        const result = await response.json();
        const rawJsonText = result.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Nettoyage intelligent au cas où du markdown est présent
        const jsonMatch = rawJsonText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            return res.status(500).json({ error: "Format de réponse invalide reçu de Gemini.", raw: rawJsonText });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        return res.status(200).json(parsed);

    } catch (error) {
        console.error("Serverless Handler Error:", error);
        return res.status(500).json({ error: "Erreur serveur lors de la recherche des pronostics.", message: error.message });
    }
}
