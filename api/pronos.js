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
            error: "La clé GEMINI_API_KEY est manquante dans Vercel. Allez dans Settings > Environment Variables, ajoutez GEMINI_API_KEY et cliquez sur Redeploy." 
        });
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false });

    const systemPrompt = `Tu es un expert en pronostics sportifs. Recherche sur le Web les matchs réels de Football prévus AUJOURD'HUI (${dateStr}) avec un coup d'envoi APRÈS ${timeStr}.
Examine les statistiques H2H et la forme récente des deux équipes.
Tu dois répondre UNIQUEMENT avec un tableau JSON valide. Aucun texte avant, aucun texte après, aucune balise markdown.

Exemple de format attendu :
[
  {
    "type": "GOALS",
    "league": "Match du Jour",
    "match": "Équipe A vs Équipe B",
    "time": "21:00",
    "selection": "Plus de 2.5 Buts",
    "odds": 1.75,
    "confidence": "85%",
    "tip": "Analyse H2H et dynamique récente des deux équipes."
  }
]`;

    const userQuery = `Trouve 3 à 5 matchs réels de football d'aujourd'hui (${dateStr}) joués après ${timeStr}. Format JSON pur uniquement.`;

    try {
        // Liste des modèles à essayer par ordre de priorité
        const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
        let rawText = null;
        let lastError = null;

        for (const model of models) {
            try {
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: userQuery }] }],
                        systemInstruction: { parts: [{ text: systemPrompt }] }
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (rawText) break;
                } else {
                    const errPayload = await response.text();
                    console.error(`Erreur modèle ${model}:`, errPayload);
                    lastError = errPayload;
                }
            } catch (err) {
                console.error(`Exception modèle ${model}:`, err);
                lastError = err.message;
            }
        }

        if (!rawText) {
            return res.status(500).json({ 
                error: "L'API Google Gemini n'a pas pu répondre. Vérifiez la clé API.", 
                details: lastError 
            });
        }

        // Nettoyage et extraction du JSON dans la réponse
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            return res.status(500).json({ error: "L'IA a répondu mais le format JSON n'a pas pu être extrait.", raw: rawText });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        return res.status(200).json(parsed);

    } catch (error) {
        console.error("Serverless Handler Error:", error);
        return res.status(500).json({ error: "Erreur serveur.", message: error.message });
    }
}
