export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');

    return res.status(405).json({
      error: 'Méthode non autorisée.'
    });
  }

  const footballKey =
    process.env.API_FOOTBALL_KEY?.trim();

  const supabaseUrl = process.env.SUPABASE_URL
    ?.trim()
    .replace(/\/+$/, '');

  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY?.trim();

  if (!footballKey || !supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({
      error:
        'Configuration incomplète. Vérifie API_FOOTBALL_KEY, ' +
        'SUPABASE_URL et SUPABASE_ANON_KEY dans Vercel.'
    });
  }

  const authorization = req.headers.authorization;

  if (
    typeof authorization !== 'string' ||
    !/^Bearer\s+\S+$/i.test(authorization)
  ) {
    return res.status(401).json({
      error: 'Connecte-toi à BetTracker avant de lancer le test.'
    });
  }

  try {
    // Vérifier la session de l’utilisateur.
    const authResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: supabaseAnonKey,
          Authorization: authorization
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!authResponse.ok) {
      return res.status(
        authResponse.status >= 500 ? 503 : 401
      ).json({
        error:
          authResponse.status >= 500
            ? 'Vérification de session temporairement indisponible.'
            : 'Session invalide ou expirée. Reconnecte-toi.'
      });
    }

    const user = await authResponse.json();

    if (!user?.id) {
      return res.status(401).json({
        error: 'Session utilisateur invalide.'
      });
    }

    // Appel de diagnostic uniquement.
    const response = await fetch(
      'https://v3.football.api-sports.io/status',
      {
        headers: {
          'x-apisports-key': footballKey,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    const raw = await response.text();
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error:
          'Le fournisseur sportif a renvoyé une réponse non JSON.',
        upstreamStatus: response.status
      });
    }

    if (!response.ok) {
      console.error('[football] Erreur HTTP fournisseur', {
        status: response.status,
        errors: data?.errors
      });

      return res.status(502).json({
        error:
          'La connexion à API-Football a été refusée ou a échoué.',
        upstreamStatus: response.status
      });
    }

    // Certaines erreurs métier peuvent être renvoyées avec HTTP 200.
    const providerErrors = data?.errors;

    const hasErrors =
      providerErrors &&
      typeof providerErrors === 'object' &&
      Object.keys(providerErrors).length > 0;

    if (hasErrors) {
      console.error('[football] Erreur fournisseur', {
        errors: providerErrors
      });

      return res.status(502).json({
        error:
          'API-Football signale une erreur. ' +
          'Vérifie la clé, son activation et les journaux Vercel.'
      });
    }

    if (!data?.response || typeof data.response !== 'object') {
      return res.status(502).json({
        error: 'Réponse de diagnostic inattendue.'
      });
    }

    // Ne pas renvoyer les informations personnelles du compte fournisseur.
    return res.status(200).json({
      ok: true,
      message: 'Connexion à API-Football réussie.',
      subscription: data.response.subscription || null,
      requests: data.response.requests || null,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[football] Échec du diagnostic', {
      name: error?.name,
      message: error?.message
    });

    return res.status(
      error?.name === 'TimeoutError' ? 504 : 502
    ).json({
      error:
        error?.name === 'TimeoutError'
          ? 'Le service a mis trop de temps à répondre.'
          : 'Impossible de vérifier la connexion au service sportif.'
    });
  }
}
