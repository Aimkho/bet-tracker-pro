export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({error:'Utilise GET.'});
  }
  const key=process.env.API_FOOTBALL_KEY?.trim();
  const base=process.env.SUPABASE_URL?.trim().replace(/\/+$/,'');
  const anon=process.env.SUPABASE_ANON_KEY?.trim();
  if(!key||!base||!anon) return res.status(500).json({error:'Vérifie API_FOOTBALL_KEY, SUPABASE_URL et SUPABASE_ANON_KEY dans Vercel.'});
  const authorization=req.headers.authorization;
  if(typeof authorization!=='string'||!/^Bearer\s+\S+$/i.test(authorization))return res.status(401).json({error:'Connecte-toi à BetTracker puis recharge cette page.'});
  try {
    const auth=await fetch(`${base}/auth/v1/user`,{headers:{apikey:anon,Authorization:authorization},signal:AbortSignal.timeout(10000)});
    if(!auth.ok)return res.status(auth.status>=500?503:401).json({error:'Impossible de vérifier la session. Reconnecte-toi si elle a expiré.'});
    const user=await auth.json();
    if(!user?.id)return res.status(401).json({error:'Session invalide.'});
    const url=new URL(req.url,'https://local.invalid');
    const action=url.searchParams.get('action')||'catalog';
    if(!['catalog','fixtures'].includes(action))return res.status(400).json({error:'Action invalide.'});
    let endpoint;
    if(action==='catalog')endpoint='leagues?current=true';
    else {
      const id=url.searchParams.get('id');
      const season=url.searchParams.get('season');
      if(!/^\d{1,7}$/.test(id||'')||!/^\d{4}$/.test(season||''))return res.status(400).json({error:'Identifiant ou saison invalide.'});
      endpoint=`fixtures?league=${encodeURIComponent(id)}&season=${encodeURIComponent(season)}`;
    }
    const upstream=await fetch('https://v3.football.api-sports.io/'+endpoint,{headers:{'x-apisports-key':key,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
    const raw=await upstream.text();
    let data;
    try{data=JSON.parse(raw);}catch{return res.status(502).json({error:'Réponse du fournisseur non JSON.',upstreamStatus:upstream.status});}
    const quota={remaining:upstream.headers.get('x-ratelimit-requests-remaining'),limit:upstream.headers.get('x-ratelimit-requests-limit')};
    const errors=data?.errors;
    if(!upstream.ok||(errors&&typeof errors==='object'&&Object.keys(errors).length)){
      return res.status(upstream.status===429?429:502).json({error:'Le fournisseur a refusé cette demande.',providerErrors:errors||null,upstreamStatus:upstream.status,quota});
    }
    if(!Array.isArray(data.response))return res.status(502).json({error:'Format du fournisseur inattendu.'});
    if(action==='fixtures')return res.status(200).json({ok:true,count:data.response.length,quota,sample:data.response.slice(0,3).map(x=>({id:x.fixture?.id,date:x.fixture?.date,status:x.fixture?.status?.short,home:x.teams?.home?.name,away:x.teams?.away?.name,score:{home:x.goals?.home,away:x.goals?.away}}))});
    const targets=[
      {label:'Bundesliga',country:'Germany',names:['Bundesliga']},
      {label:'Eredivisie',country:'Netherlands',names:['Eredivisie']},
      {label:'Premier League',country:'England',names:['Premier League']},
      {label:'Liga',country:'Spain',names:['La Liga']},
      {label:'Serie A (Italie)',country:'Italy',names:['Serie A']},
      {label:'Ligue des champions UEFA',country:'World',names:['UEFA Champions League']},
      {label:'Saudi Pro League',country:'Saudi-Arabia',names:['Pro League','Saudi Pro League']},
      {label:'Première division portugaise',country:'Portugal',names:['Primeira Liga','Liga Portugal']},
      {label:'Série A (Brésil)',country:'Brazil',names:['Serie A','Brasileirão Série A']},
      {label:'Première division argentine',country:'Argentina',names:['Liga Profesional Argentina','Primera Division','Liga Profesional']},
      {label:'MLS',country:'USA',names:['Major League Soccer','MLS']},
      {label:'Jupiler Pro League',country:'Belgium',names:['Jupiler Pro League']},
      {label:'AFC Champions League Elite',country:'World',names:['AFC Champions League Elite','AFC Champions League']}
    ];
    const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const competitions=targets.map(t=>{
      const candidates=data.response.filter(x=>norm(x.country?.name)===norm(t.country)&&t.names.some(n=>norm(n)===norm(x.league?.name)));
      return {label:t.label,candidates:candidates.map(x=>({id:x.league?.id,name:x.league?.name,country:x.country?.name,seasons:(x.seasons||[]).filter(s=>s.current).map(s=>({year:s.year,start:s.start,end:s.end,coverage:s.coverage||{}}))}))};
    });
    return res.status(200).json({ok:true,competitions,quota,checkedAt:new Date().toISOString(),note:'Le catalogue et les indicateurs de couverture ne prouvent pas l’accès aux rencontres avec ton abonnement.'});
  }catch(e){console.error('[football-verify]',{name:e.name,message:e.message});return res.status(e.name==='TimeoutError'?504:502).json({error:e.name==='TimeoutError'?'Délai dépassé. Réessaie.':'Vérification impossible. Consulte les journaux Vercel.'});}
}
