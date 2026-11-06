// Contexte privé pour le deuxième appel Gemini uniquement, sans outil Google Search.
// Les résultats restent déclarés par l'utilisateur ; aucun entraînement du modèle.
const MAX_ROWS = 50;
const MAX_LEGS = 40;
const LEG_RESULTS = new Set(['PENDING','WON','LOST','VOID']);
const CLOSED = new Set(['WON','LOST','REFUNDED','CASHED_OUT']);
const clean = (v,n=400) => typeof v === 'string' ? v.trim().slice(0,n) : '';
const number = v => v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

export async function loadResultHistory({supabaseUrl,headers,userId,signal,deadline}) {
  const cap=Math.min(5000,Number.isFinite(deadline)?deadline-Date.now()-1000:5000);
  if(cap<=0||signal?.aborted)return {status:'unavailable',rows:[],warnings:['Budget de chargement épuisé.']};
  const localSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(cap)]):AbortSignal.timeout(cap);
  const query=(table,select,order='date.desc,id.desc')=>{
    const params=new URLSearchParams({select,user_id:`eq.${userId}`,order,limit:String(MAX_ROWS)});
    return fetch(`${supabaseUrl}/rest/v1/${table}?${params}`,{headers,signal:localSignal,redirect:'error'})
      .then(async response=>{
        if(!response.ok)return {status:response.status===401||response.status===403?'access_denied':'unavailable',rows:[]};
        const rows=await response.json();return Array.isArray(rows)?{status:rows.length?'available':'empty',rows}:{status:'unavailable',rows:[]};
      }).catch(()=>({status:'unavailable',rows:[]}));
  };
  const [manual,imported]=await Promise.all([
    query('bets','id,date,sport,match,stake,odds,status,notes,settled_return,settled_at,analysis_context'),
    query('imported_coupons','id,date,sport,bookmaker,currency,stake,total_odds,status,selections,coupon_data,settled_return,settled_at')
  ]);
  return buildResultHistory(manual,imported);
}

export function buildResultHistory(manual,imported) {
  const warnings=[];
  if(!['available','empty'].includes(manual.status))warnings.push('Les paris manuels/IA sont indisponibles : absence de données ne signifie pas absence de pertes.');
  if(!['available','empty'].includes(imported.status))warnings.push('Les coupons importés sont indisponibles.');
  const replaced=new Set();
  const ids=new Set(manual.rows.map(b=>String(b.id)));
  const records=[];
  for(const c of imported.rows){
    const link=clean(c.coupon_data?.metricLinkedBetId,150);
    const confirmedSelections=extractLegs(c.selections);
    // Un lien explicite signifie même pari. Si deux coupons partagent ce lien,
    // ne pas apprendre de ce conflit en comptant deux fois la même observation.
    if(link&&replaced.has(link)){warnings.push('Deux coupons partagent un même lien de doublon : une seule observation conservée.');continue;}
    if(link&&ids.has(link))replaced.add(link);
    const record=makeRecord(c,'imported',confirmedSelections);
    if(record)records.push(record);
  }
  for(const b of manual.rows){
    if(replaced.has(String(b.id)))continue;
    const legs=parseNoteSelections(b.notes);
    const record=makeRecord(b,b.analysis_context?.origin==='AI'?'AI_saved':'manual_or_legacy',legs);
    if(record){
      if(b.analysis_context?.origin==='AI'){
        const predictions=Array.isArray(b.analysis_context.predictions)?b.analysis_context.predictions:[];
        record.originalAnalysis=predictions.slice(0,MAX_LEGS).map(p=>({
          event:clean(p.match),selection:clean(p.selection),reasoningAtPredictionTime:clean(p.tip,700)
        }));
      }
      records.push(record);
    }
  }
  records.sort((a,b)=>(b.settledAt||b.betDate||'').localeCompare(a.settledAt||a.betDate||''));
  const rows=[];let contextChars=0,omittedRecords=0;
  for(const record of records.slice(0,MAX_ROWS*2)){
    const copy={...record,selections:[]};let recordChars=0,omittedLegs=0;
    for(const leg of record.selections){
      const size=JSON.stringify(leg).length;
      if(recordChars+size>12000){omittedLegs++;continue;}
      copy.selections.push(leg);recordChars+=size;
    }
    if(omittedLegs)copy.omittedSelectionDetails=omittedLegs;
    const size=JSON.stringify(copy).length;
    if(contextChars+size>45000){omittedRecords++;continue;}
    rows.push(copy);contextChars+=size;
  }
  if(omittedRecords)warnings.push(`${omittedRecords} coupon(s) omis du contexte pour respecter sa limite de taille.`);
  if(rows.some(r=>r.omittedSelectionDetails))warnings.push('Certains coupons ont des détails de sélections tronqués dans ce contexte, sans modifier les données enregistrées.');
  const groups=new Map();
  let knownLegs=0,won=0,lost=0,voided=0,observedReasons=0;
  for(const record of rows){
    for(const leg of record.selections){
      if(leg.result==='PENDING')continue;
      knownLegs++;
      if(leg.result==='WON')won++;
      if(leg.result==='LOST')lost++;
      if(leg.result==='VOID')voided++;
      if(leg.failureObservation)observedReasons++;
      // Groupement exact, aucune classification de marché inventée.
      const key=leg.market.toLocaleLowerCase('fr-FR').replace(/\s+/g,' ').trim();
      if(!key)continue;
      if(!groups.has(key))groups.set(key,{market:leg.market,won:0,lost:0,voided:0});
      const g=groups.get(key);if(leg.result==='WON')g.won++;if(leg.result==='LOST')g.lost++;if(leg.result==='VOID')g.voided++;
    }
  }
  const bothAvailable=['available','empty'].includes(manual.status)&&['available','empty'].includes(imported.status);
  return {
    status:rows.length?(bothAvailable?'available':'partial'):(bothAvailable?'empty':'unavailable'),
    dataSources:{manual:manual.status,imported:imported.status},
    rows,
    summary:{sampledCoupons:rows.length,knownSelectionOutcomes:knownLegs,won,lost,voided,observedReasons,
      exactMarketGroups:[...groups.values()].sort((a,b)=>(b.won+b.lost+b.voided)-(a.won+a.lost+a.voided)).slice(0,30)},
    warnings,
    interpretationRules:[
      'Échantillon limité aux derniers enregistrements disponibles, non représentatif de tous les paris possibles.',
      'Résultats et causes déclarés par l’utilisateur, non vérifiés indépendamment.',
      'Une perte de coupon ne rend pas toutes ses sélections perdantes. Aucun résultat individuel n’est déduit du statut global.',
      'Les sélections d’un même coupon et les occurrences répétées d’un match ne sont pas des observations indépendantes.',
      'Les commentaires d’échec sont des constats ou hypothèses de l’utilisateur, pas des causes établies.',
      'Utiliser les échecs comme points de contrôle à vérifier dans les informations actuelles, pas comme preuve de gains futurs.',
      'Ne pas augmenter la mise, promettre un gain ou exclure un marché sur quelques pertes isolées.',
      'Pas de réentraînement ni de mémoire du modèle : ces données sont relues à chaque demande.',
      'Un résultat encore PENDING n’est pas une preuve d’échec ou de réussite.',
      'Les montants non renseignés restent null ; les anciens retours potentiels ne sont pas des règlements confirmés.'
    ]
  };
}

function makeRecord(b,source,selections){
  if(!b||typeof b!=='object')return null;
  const hasOutcome=selections.some(s=>s.result!=='PENDING');
  if(!CLOSED.has(b.status)&&!hasOutcome)return null;
  return {
    source,betDate:clean(b.date,30),settledAt:clean(b.settled_at,30)||null,
    sport:clean(b.sport,80),couponStatus:clean(b.status,30),
    couponLabel:clean(b.match),bookmaker:clean(b.bookmaker,100)||null,
    currency:source==='imported'?clean(b.currency,3):'EUR',
    stake:number(b.stake),totalOdds:number(b.total_odds??b.odds),
    creditedMoney:number(b.settled_return),
    selections
  };
}
function extractLegs(items){
  if(!Array.isArray(items))return [];
  return items.slice(0,MAX_LEGS).filter(s=>s&&typeof s==='object'&&!Array.isArray(s)).map(s=>({
    event:clean(s.event),competition:clean(s.competition,150),
    market:clean(s.market,700),scope:clean(s.scope,200),
    conditions:Array.isArray(s.conditions)?s.conditions.map(x=>clean(x)).filter(Boolean).join(' ET '):clean(s.conditions,700),
    odds:number(s.odds),result:LEG_RESULTS.has(s.result)?s.result:'PENDING',
    failureObservation:clean(s.failureReason,700),origin:clean(s.origin,50)
  }));
}
function parseNoteSelections(notes){
  const marker='BETTRACKER_SELECTIONS_V1:';
  if(typeof notes!=='string'||!notes.startsWith(marker))return [];
  const end=notes.indexOf('\n');if(end<0)return [];
  try{return extractLegs(JSON.parse(notes.slice(marker.length,end)));}catch{return [];}
}
