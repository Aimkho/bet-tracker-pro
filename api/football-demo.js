// Démonstration historique : Bundesliga, saison 2024.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Utilise GET.' });
  }
  const key=process.env.API_FOOTBALL_KEY?.trim();
  const base=process.env.SUPABASE_URL?.trim().replace(/\/+$/,'');
  const anon=process.env.SUPABASE_ANON_KEY?.trim();
  if(!key||!base||!anon)return res.status(500).json({error:'Vérifie API_FOOTBALL_KEY, SUPABASE_URL et SUPABASE_ANON_KEY dans Vercel.'});
  const authorization=req.headers.authorization;
  if(typeof authorization!=='string'||!/^Bearer\s+\S+$/i.test(authorization))return res.status(401).json({error:'Connecte-toi à BetTracker sur ce même domaine.'});
  try {
    const auth=await fetch(`${base}/auth/v1/user`,{headers:{apikey:anon,Authorization:authorization},signal:AbortSignal.timeout(10000)});
    if(!auth.ok)return res.status(auth.status>=500?503:401).json({error:'Session non vérifiable. Reconnecte-toi si elle est expirée.'});
    const user=await auth.json();
    if(!user?.id)return res.status(401).json({error:'Session invalide.'});
    const url=new URL(req.url,'https://local.invalid');
    const action=url.searchParams.get('action')||'fixtures';
    let endpoint;
    if(action==='fixtures')endpoint='fixtures?league=78&season=2024&timezone=Europe%2FParis';
    else if(action==='statistics'){
      const fixture=url.searchParams.get('fixture');
      if(!/^\d{1,10}$/.test(fixture||''))return res.status(400).json({error:'Identifiant de match invalide.'});
      endpoint='fixtures/statistics?fixture='+encodeURIComponent(fixture);
    } else return res.status(400).json({error:'Action invalide.'});
    const response=await fetch('https://v3.football.api-sports.io/'+endpoint,{headers:{'x-apisports-key':key,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
    let data;
    try {data=JSON.parse(await response.text());}
    catch {return res.status(502).json({error:'Réponse du fournisseur non JSON.',upstreamStatus:response.status});}
    if(!response.ok||(data.errors&&typeof data.errors==='object'&&Object.keys(data.errors).length))return res.status(response.status===429?429:502).json({error:'Le fournisseur a refusé la demande. Examine le détail avant de réessayer.',providerErrors:data.errors||null,upstreamStatus:response.status});
    if(!Array.isArray(data.response))return res.status(502).json({error:'Format de réponse du fournisseur inattendu.'});
    if(action==='statistics')return res.status(200).json({ok:true,historicalDemo:true,teams:data.response.map(t=>({id:t.team?.id,name:t.team?.name,statistics:(t.statistics||[]).map(s=>({type:s.type,value:s.value??null}))}))});
    const matches=data.response.filter(x=>x.league?.id===78&&x.league?.season===2024&&x.fixture?.status?.short==='FT').sort((a,b)=>Date.parse(b.fixture.date)-Date.parse(a.fixture.date)).slice(0,12).map(x=>({id:x.fixture.id,date:x.fixture.date,league:x.league.name,season:x.league.season,home:{id:x.teams?.home?.id,name:x.teams?.home?.name},away:{id:x.teams?.away?.id,name:x.teams?.away?.name},goals:{home:x.goals?.home??null,away:x.goals?.away??null}}));
    return res.status(200).json({ok:true,historicalDemo:true,returnedByProvider:data.response.length,matches,fetchedAt:new Date().toISOString()});
  }catch(error){console.error('[football-demo]',{name:error.name,message:error.message});return res.status(error.name==='TimeoutError'?504:502).json({error:error.name==='TimeoutError'?'Délai dépassé. Réessaie ultérieurement.':'Récupération impossible. Consulte les journaux Vercel.'});}
}
