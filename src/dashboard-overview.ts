export const overviewMarkup = `
  <div class="section-intro"><div><h1>운영 개요</h1><p>Cursor 연결과 요청 흐름을 한눈에 확인하세요.</p></div><p id="metricsState" class="metrics-state" role="status">지표를 불러오는 중입니다.</p></div>
  <div class="kpis" aria-label="Completion 지표">
    <article class="card kpi"><div class="kpi-label">전체 요청</div><div id="metricRequests" class="kpi-value">—</div><div class="kpi-hint">프로세스 시작 이후</div></article>
    <article class="card kpi"><div class="kpi-label">진행 중</div><div id="metricInFlight" class="kpi-value">—</div><div class="kpi-hint">현재 처리 중인 요청</div></article>
    <article class="card kpi"><div class="kpi-label">성공률</div><div id="metricSuccess" class="kpi-value">—</div><div class="kpi-hint">종료된 요청 기준</div></article>
    <article class="card kpi"><div class="kpi-label">평균 응답 시간</div><div id="metricLatency" class="kpi-value">—</div><div class="kpi-hint">취소·실패·제한 포함</div></article>
  </div>
  <div class="pair">
    <section class="card" aria-labelledby="outcomesTitle"><h2 id="outcomesTitle">요청 결과 <span class="sub">완료된 요청</span></h2><div id="metricOutcomes" class="outcomes"><div class="empty">아직 집계된 요청이 없습니다.</div></div><p class="footnote">HTTP 200 이후 발생한 SSE 오류도 실패로 집계합니다.</p></section>
    <section class="card" aria-labelledby="routesTitle"><h2 id="routesTitle">경로별 요청 <span class="sub">Direct / LiteLLM</span></h2><div id="metricRoutes"><div class="empty">아직 집계된 요청이 없습니다.</div></div><p class="footnote">클라이언트가 보낸 경로 태그입니다. 실제 경유 경로를 인증하지 않습니다.</p></section>
  </div>
`;

/** Runs inside the existing dashboard script and reuses its authenticated fetch boundary. */
export const overviewScript = String.raw`
let metricsController=null;
let metricsSnapshot=null;
let liveMetrics=true;
let metricsTimer;
const tabNames=['overview','credentials','models','settings','info'];

function selectDashboardTab(name,focus=false){
  if(!tabNames.includes(name))name='overview';
  tabNames.forEach(value=>{
    const selected=value===name;
    const tab=$('tab-'+value);
    tab.setAttribute('aria-selected',String(selected));
    tab.tabIndex=selected?0:-1;
    $('panel-'+value).hidden=!selected;
  });
  if(focus)$('tab-'+name).focus();
  history.replaceState(null,'','#'+name);
}
document.querySelectorAll('[role=tab]').forEach(tab=>{
  tab.addEventListener('click',()=>selectDashboardTab(tab.dataset.tab));
  tab.addEventListener('keydown',event=>{
    const index=tabNames.indexOf(tab.dataset.tab);
    let target;
    if(event.key==='ArrowRight')target=tabNames[(index+1)%tabNames.length];
    if(event.key==='ArrowLeft')target=tabNames[(index+tabNames.length-1)%tabNames.length];
    if(event.key==='Home')target=tabNames[0];
    if(event.key==='End')target=tabNames[tabNames.length-1];
    if(target){event.preventDefault();selectDashboardTab(target,true);}
  });
});
selectDashboardTab(location.hash.slice(1));
window.addEventListener('hashchange',()=>selectDashboardTab(location.hash.slice(1)));

function applyDashboardTheme(theme){
  document.documentElement.dataset.theme=theme;
  $('themeToggle').setAttribute('aria-pressed',String(theme==='light'));
  $('themeToggle').setAttribute('aria-label',theme==='dark'?'라이트 테마로 변경':'다크 테마로 변경');
  $('themeToggle').textContent=theme==='dark'?'라이트':'다크';
}
let storedTheme='dark';
try{if(localStorage.getItem('cursorBridgeTheme')==='light')storedTheme='light';}catch{}
applyDashboardTheme(storedTheme);
$('themeToggle').addEventListener('click',()=>{
  const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
  applyDashboardTheme(theme);
  try{localStorage.setItem('cursorBridgeTheme',theme);}catch{}
});

function renderCompletionMetrics(snapshot){
  const series=snapshot.series;
  const total=series.reduce((sum,row)=>{
    for(const key of ['requests','in_flight','success','backend_error','aborted','rate_limited'])sum[key]+=row[key];
    sum.elapsed+=row.latency_ms.total;
    sum.completed+=row.latency_ms.count;
    return sum;
  },{requests:0,in_flight:0,success:0,backend_error:0,aborted:0,rate_limited:0,elapsed:0,completed:0});
  setText('metricRequests',total.requests.toLocaleString('ko-KR'));
  setText('metricInFlight',total.in_flight.toLocaleString('ko-KR'));
  setText('metricSuccess',total.completed?formatPercent(total.success/total.completed*100):'—');
  setText('metricLatency',total.completed?(total.elapsed/total.completed/1000).toFixed(2)+'s':'—');
  const outcomes=$('metricOutcomes');outcomes.replaceChildren();
  if(!total.completed)outcomes.append(make('div','empty','아직 완료된 요청이 없습니다.'));
  else [['success','성공',''],['backend_error','실패','error'],['aborted','취소','abort'],['rate_limited','동시성 제한','limited']].forEach(([key,label,tone])=>{
    const row=make('div');
    const head=make('div','outcome-head');head.append(make('span','',label),make('span','',total[key].toLocaleString('ko-KR')+' · '+formatPercent(total[key]/total.completed*100)));
    const track=make('div','outcome-track');track.setAttribute('aria-hidden','true');
    const fill=make('div','outcome-fill '+tone);fill.style.width=total[key]/total.completed*100+'%';
    track.append(fill);row.append(head,track);outcomes.append(row);
  });
  const routes=$('metricRoutes');routes.replaceChildren();
  for(const route of ['direct','litellm','unknown']){
    const rows=series.filter(row=>row.route===route);
    const requests=rows.reduce((sum,row)=>sum+row.requests,0);
    const active=rows.reduce((sum,row)=>sum+row.in_flight,0);
    const item=make('div','route-row');item.append(make('code','',route),make('span','',requests.toLocaleString('ko-KR')+'건'),make('span','muted','진행 '+active));
    routes.append(item);
  }
}
async function loadCompletionMetrics(){
  if(metricsController||!dashboardData)return;
  const controller=new AbortController();metricsController=controller;
  $('refreshOverview').disabled=true;
  try{
    const snapshot=await fetchJson('/admin/metrics',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])},true);
    if(controller.signal.aborted)return;
    metricsSnapshot=snapshot;renderCompletionMetrics(snapshot);
    const since=new Date(snapshot.since);
    setText('metricsState',(liveMetrics?'5초마다 갱신':'자동 갱신 일시 정지')+' · 집계 시작 '+since.toLocaleTimeString('ko-KR'));
    $('metricsState').className='metrics-state';
  }catch(error){
    if(controller.signal.aborted)return;
    setText('metricsState',(metricsSnapshot?'이전 지표 표시 중 · ':'')+'지표 조회 실패. 새로고침으로 다시 시도하세요.');
    $('metricsState').className='metrics-state error';
    if(error&&error.status===401)handleAdminError(error);
  }finally{
    if(metricsController===controller)metricsController=null;
    $('refreshOverview').disabled=false;
  }
}
function scheduleMetrics(){
  clearTimeout(metricsTimer);
  if(liveMetrics&&!document.hidden)metricsTimer=setTimeout(async()=>{
    await loadCompletionMetrics();scheduleMetrics();
  },5000);
}
$('liveToggle').addEventListener('click',()=>{
  liveMetrics=!liveMetrics;
  $('liveToggle').setAttribute('aria-pressed',String(liveMetrics));
  $('liveToggle').textContent=liveMetrics?'실시간':'일시 정지';
  if(!liveMetrics){metricsController?.abort();setText('metricsState','자동 갱신 일시 정지');}
  else void loadCompletionMetrics();
  scheduleMetrics();
});
$('refreshOverview').addEventListener('click',()=>void loadCompletionMetrics());
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)metricsController?.abort();
  scheduleMetrics();
});
window.addEventListener('pagehide',()=>{clearTimeout(metricsTimer);metricsController?.abort();});
scheduleMetrics();
`;
