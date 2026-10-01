import { dashboardTheme } from './dashboard-theme.js';
import { overviewMarkup, overviewScript } from './dashboard-overview.js';

// allow: SIZE_OK — self-contained dashboard HTML/CSS/JS artifact served without runtime assets.
function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export function renderDashboard(version: string): string {
  return `<!doctype html>
<html lang="ko" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cursor AI Bridge 관리 콘솔</title>
  <meta name="description" content="Cursor AI Bridge 운영 상태, 크리덴셜, 모델과 라우팅을 관리하는 콘솔" />
  <link rel="icon" href="data:," />
  <style>${dashboardTheme}</style>
</head>
<body>
  <a class="skip-link" href="#app">본문으로 건너뛰기</a>
  <header class="site-header"><div class="wrap header-row">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><div><p class="brand-name">Cursor AI <em>Bridge</em></p><p class="kicker">YELIXIR-DEV / CURSOR-AI-PROXY-BRIDGE</p></div></div>
    <div class="header-actions"><span class="health-pill"><i id="healthDot" class="dot" aria-hidden="true"></i><span id="healthLabel">확인 중</span><span id="bridgeVersion" class="version">v${escapeHtml(
      version,
    )}</span></span><button id="liveToggle" class="secondary" aria-pressed="true" type="button">실시간</button><button id="refreshOverview" class="secondary" type="button">새로고침</button><button id="themeToggle" class="secondary" aria-label="라이트 테마" aria-pressed="false" type="button">라이트</button><button id="changeKey" class="secondary" type="button">API key</button></div>
  </div></header>
  <main id="app" class="wrap main" aria-busy="true" tabindex="-1">
    <div id="pageState" class="page-state" role="status" hidden>설정을 불러오는 중입니다.</div>
    <div class="tabs" role="tablist" aria-label="관리 메뉴"><button id="tab-overview" class="tab" role="tab" type="button" data-tab="overview" aria-controls="panel-overview" aria-selected="true" tabindex="0"><svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span>개요</span></button>
<button id="tab-credentials" class="tab" role="tab" type="button" data-tab="credentials" aria-controls="panel-credentials" aria-selected="false" tabindex="-1"><svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="5"/><path d="m12 11 9-9m-4 4 3 3m-6 0 3 3"/></svg><span>크리덴셜</span></button>
<button id="tab-models" class="tab" role="tab" type="button" data-tab="models" aria-controls="panel-models" aria-selected="false" tabindex="-1"><svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/></svg><span>모델</span></button>
<button id="tab-settings" class="tab" role="tab" type="button" data-tab="settings" aria-controls="panel-settings" aria-selected="false" tabindex="-1"><svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v18M12 3v18M19 3v18M2 8h6m1 8h6m1-9h6"/></svg><span>설정</span></button>
<button id="tab-info" class="tab" role="tab" type="button" data-tab="info" aria-controls="panel-info" aria-selected="false" tabindex="-1"><svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></svg><span>안내</span></button></div>
    <section id="panel-overview" class="tab-panel" role="tabpanel" aria-labelledby="tab-overview">${overviewMarkup}      <section class="card wide" aria-labelledby="statusTitle">
        <h2 id="statusTitle">상태 <span class="sub">Bridge와 활성 백엔드</span></h2>
        <div class="status-grid">
          <div class="kv"><span>활성 백엔드</span><b id="activeBackend">—</b></div>
          <div class="kv"><span>서버</span><b id="serverAddress">—</b></div>
          <div class="kv"><span>Bridge 버전</span><b id="statusVersion">v${escapeHtml(
            version,
          )}</b></div>
          <div class="kv"><span>상태 요약</span><b id="healthSummary">확인 중</b></div>
        </div>
      </section>

</section>
    <section id="panel-credentials" class="tab-panel" role="tabpanel" aria-labelledby="tab-credentials" hidden>      <section class="card wide" aria-labelledby="credentialsTitle">
        <h2 id="credentialsTitle">크리덴셜 <span class="sub">Upstream Cursor API keys</span></h2>
        <form id="addCredential" class="add-form" autocomplete="off">
          <div class="field"><label for="credentialId">ID</label><input id="credentialId" name="id" maxlength="100" required placeholder="team-primary" /></div>
          <div class="field"><label for="credentialLabel">라벨</label><input id="credentialLabel" name="label" maxlength="200" placeholder="운영 계정" /></div>
          <div class="field field-wide"><label for="credentialKey">Cursor API key</label><input id="credentialKey" name="apiKey" type="password" required autocomplete="new-password" placeholder="새 key 입력" /></div>
          <div class="field"><label for="credentialWeight">가중치</label><input id="credentialWeight" name="weight" type="number" min="0.01" step="0.01" value="1" required /></div>
          <div class="field"><label for="credentialPlan">플랜</label><select id="credentialPlan" name="plan"><option value="other">Other</option><option value="pro">Pro</option><option value="pro_plus">Pro+</option><option value="ultra">Ultra</option></select></div>
          <div class="field capability-field"><label for="credentialFableCapability" title="Ultra 플랜 전용"><input id="credentialFableCapability" name="fableCapability" type="checkbox" aria-describedby="credentialFableDescription" disabled /> Fable 사용 가능 · Ultra 전용</label><span id="credentialFableDescription" class="visually-hidden">Ultra 플랜에서만 활성화됩니다.</span></div>
          <div class="add-actions"><button data-admin-control type="submit">추가</button></div>
        </form>
        <div id="credentialEmpty" class="empty" hidden>대시보드에서 관리하는 크리덴셜이 없습니다. 위 폼에서 key를 추가하세요.</div>
        <div class="table-wrap" role="region" aria-label="Credential table" tabindex="0">
          <table>
            <thead><tr><th>ID</th><th>라벨</th><th>플랜</th><th>Fable</th><th id="credentialWeightHeading">가중치 <span id="credentialWeightPolicyNote" class="weight-policy-note" hidden>무시됨</span></th><th>사용</th><th>Key</th><th>상태</th><th>작업</th></tr></thead>
            <tbody id="credentialRows"><tr><td colspan="9" class="muted">불러오는 중</td></tr></tbody>
          </table>
        </div>
        <div class="usage-section" role="region" aria-labelledby="credentialUsageTitle">
          <div class="usage-heading">
            <div><h3 id="credentialUsageTitle">계정 사용량</h3><p>Cursor Models와 Other Models pool을 credential별로 조회합니다.</p></div>
            <button id="refreshCredentialUsage" class="secondary" data-admin-control type="button">새로고침</button>
          </div>
          <div id="credentialUsageList" class="usage-list" aria-live="polite"><div class="empty">불러오는 중</div></div>
        </div>
      </section>

</section>
    <section id="panel-models" class="tab-panel" role="tabpanel" aria-labelledby="tab-models" hidden>      <section class="card wide" aria-labelledby="modelsTitle">
        <h2 id="modelsTitle">모델 <span id="modelHeadingCount" class="sub">활성 0 / 전체 0</span></h2>
        <div class="model-tools"><label class="search"><span class="visually-hidden">모델 검색</span><input id="modelSearch" type="search" placeholder="모델 ID 검색" autocomplete="off" /></label><span id="modelTotal" class="model-total">활성 0 / 전체 0</span></div>
        <div id="modelGroups" class="families"><div class="empty">불러오는 중</div></div>
      </section>

</section>
    <section id="panel-settings" class="tab-panel" role="tabpanel" aria-labelledby="tab-settings" hidden><div class="section-intro"><div><h1>라우팅 설정</h1><p>변경은 저장 즉시 다음 요청부터 적용됩니다.</p></div></div>        <div class="policy-panel" role="group" aria-labelledby="credentialPolicyTitle">
          <div class="policy-heading">
            <div><h3 id="credentialPolicyTitle">라우팅 및 failover 정책</h3><p>다음 요청부터 즉시 적용되며 dashboard에 저장됩니다.</p></div>
            <div class="policy-active" aria-live="polite"><span>현재 적용</span><code id="activeCredentialRouting">—</code><code id="activeCredentialFailover">—</code></div>
          </div>
          <div class="policy-grid">
            <label class="policy-field" for="credentialRoutingPolicy">
              <span class="policy-label">Routing policy</span>
              <select id="credentialRoutingPolicy" data-admin-control aria-describedby="credentialRoutingDescription">
                <option value="weighted_round_robin">weighted_round_robin</option>
                <option value="round_robin">round_robin</option>
                <option value="ultra_last">ultra_last</option>
              </select>
              <span id="credentialRoutingDescription" class="policy-description"></span>
            </label>
            <label class="policy-field" for="credentialFailoverPolicy">
              <span class="policy-label">Failover policy</span>
              <select id="credentialFailoverPolicy" data-admin-control aria-describedby="credentialFailoverDescription">
                <option value="auth">auth</option>
                <option value="auth_or_quota">auth_or_quota</option>
                <option value="auth_or_quota_or_5xx">auth_or_quota_or_5xx</option>
              </select>
              <span id="credentialFailoverDescription" class="policy-description"></span>
            </label>
          </div>
        </div>
        <div class="policy-panel" role="group" aria-labelledby="maxModeTitle">
          <div class="policy-heading">
            <div><h3 id="maxModeTitle">Max Mode 기본값</h3><p>Cursor가 max 변형을 게시한 모델에 한해 해당 변형을 선택합니다. max 변형이 없으면 표준 변형을 그대로 사용합니다.</p></div>
            <div class="policy-active" aria-live="polite"><span>현재 적용</span><code id="activeMaxMode">—</code></div>
          </div>
          <div class="policy-grid">
            <label class="policy-field" for="maxModeDefault">
              <span class="policy-label">Max Mode default</span>
              <select id="maxModeDefault" data-admin-control aria-describedby="maxModeDescription">
                <option value="off">off</option>
                <option value="on">on</option>
              </select>
              <span id="maxModeDescription" class="policy-description">reasoning_effort=max와는 별개입니다. 이 설정만 Cursor의 isMaxMode 변형을 선택합니다.</span>
            </label>
          </div>
        </div>
      <section class="card wide" aria-labelledby="guideTitle">
        <h2 id="guideTitle">안내 <span class="sub">읽기 전용 서버 설정</span></h2>
        <p class="guide"><strong>Host와 port는 이 화면에서 변경되지 않습니다.</strong> 설정 파일 또는 환경 변수를 수정한 뒤 Bridge를 재시작해야 적용됩니다.</p>
      </section>
</section>
    <section id="panel-info" class="tab-panel" role="tabpanel" aria-labelledby="tab-info" hidden><section class="card"><h2>Cursor AI Bridge <span class="sub">OpenAI-compatible API</span></h2><p class="guide">Headless Cursor API와 CLI fallback을 제공하는 로컬 브릿지입니다. 관리 설정과 크리덴셜은 기존 서버 정책을 따릅니다.</p><div class="kv"><span>Chat completions</span><b><code>/v1/chat/completions</code></b></div><div class="kv"><span>모델 목록</span><b><code>/v1/models</code></b></div><div class="kv"><span>운영 지표</span><b><code>/admin/metrics</code></b></div><p class="footnote">지표는 프로세스 메모리에만 보관되며 재시작하면 초기화됩니다. API key는 브라우저의 localStorage에 저장됩니다.</p><p class="footnote"><a href="https://github.com/yelixir-dev/cursor-ai-proxy-bridge" target="_blank" rel="noopener noreferrer">문서와 소스 보기</a></p></section></section>
  </main>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <dialog id="authDialog" aria-labelledby="authTitle">
    <form id="authForm">
      <h2 id="authTitle">Bridge API key</h2>
      <p>관리 API 인증에 사용할 CURSOR_BRIDGE_API_KEY를 입력하세요. 이 브라우저의 localStorage에만 저장됩니다.</p>
      <div class="field"><label for="authKey">API key</label><input id="authKey" type="password" required autocomplete="current-password" /></div>
      <div id="authError" class="auth-error" aria-live="polite"></div>
      <div class="dialog-actions"><button id="authCancel" class="secondary" type="button">닫기</button><button type="submit">연결</button></div>
    </form>
  </dialog>

<script>
const bridgeVersion=${scriptJson(version)};
const storageKey='cursorBridgeAdminApiKey';
const familyOrder=['composer','grok','opus','sonnet','fable','gpt-5.6','kimi','glm','기타'];
const familyMeta={
  composer:{name:'Composer',accent:'#9f4d2e'},grok:{name:'Grok',accent:'#1f6f78'},
  opus:{name:'Claude Opus',accent:'#76518b'},sonnet:{name:'Claude Sonnet',accent:'#b57920'},
  fable:{name:'Claude Fable',accent:'#9f4d2e'},'gpt-5.6':{name:'GPT-5.6',accent:'#39735c'},
  kimi:{name:'Kimi',accent:'#4267a8'},glm:{name:'GLM',accent:'#876b32'},
  '기타':{name:'기타',accent:'#6d665e'}
};
const routingDescriptions={
  weighted_round_robin:'가중치 비율대로 활성 키에 요청을 분산합니다.',
  round_robin:'활성 키를 같은 비율로 순환하며 가중치는 사용하지 않습니다.',
  ultra_last:'일반 모델은 비-Ultra 계정을 먼저 사용하고 Ultra 용량을 Fable용으로 보존합니다.'
};
const failoverDescriptions={
  auth:'401/403 인증 실패에서만 다음 키로 전환합니다.',
  auth_or_quota:'인증 실패와 quota 소진에서 다음 키로 전환합니다.',
  auth_or_quota_or_5xx:'인증·quota·rate limit·5xx 오류에서 전환합니다.'
};
const openFamilies=new Set(['composer']);
let apiKey=readStoredKey();
let dashboardData=null;
let healthData=null;
let credentialUsageData=null;
let credentialUsageError='';
let usageLoading=false;
let patching=false;
let toastTimer;
const $=id=>document.getElementById(id);

function readStoredKey(){try{return String(localStorage.getItem(storageKey)||'').trim();}catch{return '';}}
function storeKey(value){apiKey=String(value||'').trim();try{if(apiKey)localStorage.setItem(storageKey,apiKey);else localStorage.removeItem(storageKey);}catch{}}
function make(tag,className,text){const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=String(text);return item;}
function setText(id,value){const item=$(id);if(item)item.textContent=String(value??'—');}
function showPageState(message,kind){const item=$('pageState');item.textContent=message;item.className='page-state'+(kind?' '+kind:'');item.hidden=false;}
function hidePageState(){$('pageState').hidden=true;}
function showToast(message,error=false){clearTimeout(toastTimer);const item=$('toast');item.textContent=String(message);item.className='toast'+(error?' error':'')+' show';toastTimer=setTimeout(()=>item.classList.remove('show'),4200);}
function hideToast(){clearTimeout(toastTimer);$('toast').classList.remove('show');}
function errorMessage(error){return error&&error.message?String(error.message):'요청을 처리하지 못했습니다.';}
function formatPercent(value){return Number.isFinite(value)?Number(value).toFixed(1)+'%':'—';}
function formatCents(value){return Number.isFinite(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value)/100):'—';}
function formatDateTime(value){if(!Number.isFinite(value))return '—';return new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short'}).format(new Date(Number(value)));}

async function fetchJson(path,options={},authenticated=false){
  const headers={accept:'application/json',...(options.headers||{})};
  if(options.body)headers['content-type']='application/json';
  if(authenticated&&apiKey)headers.authorization='Bearer '+apiKey;
  const response=await fetch(path,{...options,headers,cache:'no-store'});
  const text=await response.text();
  let payload=null;
  if(text){try{payload=JSON.parse(text);}catch{payload=null;}}
  if(!response.ok){
    const message=payload&&payload.error&&payload.error.message?payload.error.message:(text||('HTTP '+response.status));
    const error=new Error(String(message));
    error.status=response.status;
    throw error;
  }
  return payload;
}

function showAuth(message=''){
  $('authError').textContent=message;
  const dialog=$('authDialog');
  if(!dialog.open){
    $('authKey').value='';
    dialog.showModal();
    requestAnimationFrame(()=>$('authKey').focus());
  }
}

function handleAdminError(error){
  if(error&&error.status===401){
    dashboardData=null;
    storeKey('');
    showPageState('관리 API 인증이 필요합니다.','error');
    showAuth('API key가 올바르지 않습니다.');
    return;
  }
  const message=errorMessage(error);
  showPageState('관리 설정을 불러오지 못했습니다: '+message,'error');
  showToast(message,true);
}

function renderHealth(){
  const ok=Boolean(healthData&&(healthData.status==='ok'||healthData.backend&&healthData.backend.ok));
  $('healthDot').className='dot '+(ok?'on':'off');
  setText('healthLabel',healthData?(ok?'정상':'저하'):'확인 실패');
  setText('statusVersion','v'+bridgeVersion);
  const backend=healthData&&healthData.backend;
  let summary=healthData?(ok?'정상':'저하'):'상태 확인 실패';
  if(backend&&backend.detail)summary+=' · '+backend.detail;
  setText('healthSummary',summary);
  $('healthSummary').className=ok?'good':'bad';
}

function renderStatus(){
  if(!dashboardData)return;
  const config=dashboardData.config||{};
  const state=dashboardData.state||{};
  const server=config.server||{};
  setText('activeBackend',state.activeBackend||'—');
  setText('serverAddress',server.host&&server.port?server.host+':'+server.port:'—');
}

function credentialStatus(config,state){
  if(config.enabled===false||state&&state.enabled===false)return {text:'비활성',className:'muted'};
  if(state&&state.disabledReason==='auth')return {text:'인증오류',className:'bad'};
  if(state&&state.disabledReason==='cooldown'){
    const remaining=Math.max(0,Number(state.disabledUntil||0)-Date.now());
    return {text:'쿨다운 · '+duration(remaining),className:'warn'};
  }
  return {text:'정상',className:'good'};
}
function duration(milliseconds){
  const seconds=Math.max(0,Math.ceil(milliseconds/1000));
  if(seconds<60)return seconds+'초 남음';
  const minutes=Math.ceil(seconds/60);
  return minutes+'분 남음';
}
function switchControl(checked,disabled,label,onChange){
  const wrap=make('label','switch');
  wrap.title=label;
  const input=make('input');
  input.setAttribute('aria-label',label);input.type='checkbox';input.checked=checked;input.disabled=disabled;input.dataset.adminControl='';
  if(onChange)input.addEventListener('change',onChange);
  wrap.append(input,make('span','slider'));
  return wrap;
}

function joinedCredentials(){
  const configured=dashboardData&&dashboardData.config&&dashboardData.config.credentials||[];
  const states=dashboardData&&dashboardData.state&&dashboardData.state.credentials||[];
  const stateById=new Map(states.map(item=>[String(item.id),item]));
  const rows=configured.map(item=>({config:item,state:stateById.get(String(item.id))||null}));
  const configuredIds=new Set(configured.map(item=>String(item.id)));
  states.forEach(state=>{if(!configuredIds.has(String(state.id)))rows.push({config:{id:state.id,label:state.label,weight:1,enabled:state.enabled},state});});
  return rows;
}

function renderCredentialPolicy(){
  if(!dashboardData)return;
  const policy=dashboardData.config&&dashboardData.config.credentialPolicy||{};
  const routing=policy.routingPolicy||'weighted_round_robin';
  const failover=policy.failoverOn||'auth';
  $('credentialRoutingPolicy').value=routing;
  $('credentialFailoverPolicy').value=failover;
  setText('activeCredentialRouting',routing);
  setText('activeCredentialFailover',failover);
  setText('credentialRoutingDescription',routingDescriptions[routing]||'');
  setText('credentialFailoverDescription',failoverDescriptions[failover]||'');
  const weightsIgnored=routing==='round_robin';
  $('credentialWeightPolicyNote').hidden=!weightsIgnored;
  $('credentialWeightHeading').classList.toggle('weight-ignored',weightsIgnored);
  $('credentialWeight').disabled=weightsIgnored;
  $('credentialWeight').closest('.field').classList.toggle('is-ignored',weightsIgnored);
}

function renderCredentials(){
  if(!dashboardData)return;
  const weightsIgnored=dashboardData.config&&dashboardData.config.credentialPolicy&&dashboardData.config.credentialPolicy.routingPolicy==='round_robin';
  const rows=joinedCredentials();
  const body=$('credentialRows');
  body.replaceChildren();
  const managed=rows.filter(row=>row.config.id!=='env'&&row.config.id!=='system');
  $('credentialEmpty').hidden=managed.length>0;
  if(rows.length===0){const row=make('tr');const cell=make('td','muted','등록된 크리덴셜이 없습니다.');cell.colSpan=9;row.append(cell);body.append(row);return;}
  rows.forEach(({config,state})=>{
    const id=String(config.id||'');
    const secretLocked=id==='env'||id==='system';
    const metadataLocked=id==='system';
    const row=make('tr');
    if(secretLocked)row.classList.add('credential-secret-locked');
    const idCell=make('td');idCell.append(make('code','',id));
    let lockNote=null;
    if(id==='env'){
      lockNote=make('span','locked-note','CURSOR_API_KEY 잠금 · 플랜/Fable만 편집');
      lockNote.id='credential-env-lock-note';
      idCell.append(lockNote);
    }
    if(id==='system')idCell.append(make('span','locked-note','예약된 fallback'));
    const labelCell=make('td','',config.label||state&&state.label||'—');
    const planCell=make('td');
    const plan=make('select','plan-input');plan.dataset.adminControl='';plan.disabled=metadataLocked;plan.setAttribute('aria-label',id+' 플랜');
    [['other','Other'],['pro','Pro'],['pro_plus','Pro+'],['ultra','Ultra']].forEach(([value,text])=>{const option=make('option','',text);option.value=value;option.selected=(config.plan||'other')===value;plan.append(option);});
    plan.addEventListener('change',async()=>{await patchConfig({credentials:[{id,plan:plan.value,capabilities:{fable:plan.value==='ultra'}}]});});
    planCell.append(plan);
    const capabilityCell=make('td');
    capabilityCell.append(switchControl(config.capabilities&&config.capabilities.fable===true,metadataLocked||config.plan!=='ultra',id+' Fable capability · Ultra 플랜 전용',async event=>{await patchConfig({credentials:[{id,capabilities:{fable:event.currentTarget.checked}}]});}));
    const weightCell=make('td',weightsIgnored?'weight-ignored':'');
    const weight=make('input','weight-input');weight.type='number';weight.min='0.01';weight.step='0.01';weight.value=String(config.weight??1);weight.disabled=secretLocked||weightsIgnored;weight.dataset.adminControl='';weight.setAttribute('aria-label',id+' 가중치');if(lockNote)weight.setAttribute('aria-describedby',lockNote.id);else if(weightsIgnored)weight.setAttribute('aria-describedby','credentialWeightPolicyNote');
    weight.addEventListener('change',async()=>{const value=Number(weight.value);if(!Number.isFinite(value)||value<=0){showToast('가중치는 0보다 커야 합니다.',true);renderCredentials();return;}await patchConfig({credentials:[{id,weight:value}]});});
    weightCell.append(weight);
    const enabledCell=make('td');const enabledControl=switchControl(config.enabled!==false,secretLocked,id+' 사용 여부'+(secretLocked?' · 환경변수 credential에서 잠김':''),async event=>{await patchConfig({credentials:[{id,enabled:event.currentTarget.checked}]});});if(lockNote)enabledControl.querySelector('input').setAttribute('aria-describedby',lockNote.id);enabledCell.append(enabledControl);
    const previewCell=make('td');previewCell.append(make('code','',config.apiKeyPreview||'—'));
    const status=credentialStatus(config,state);const statusCell=make('td',status.className,status.text);statusCell.dataset.credentialStatus=id;
    if(state&&state.disabledReason)statusCell.dataset.reason=String(state.disabledReason);
    if(state&&state.disabledUntil)statusCell.dataset.until=String(state.disabledUntil);
    if(config.enabled===false)statusCell.dataset.enabled='false';
    const actionCell=make('td');const remove=make('button','danger','삭제');remove.type='button';remove.disabled=secretLocked;remove.dataset.adminControl='';if(lockNote)remove.setAttribute('aria-describedby',lockNote.id);remove.addEventListener('click',async()=>{if(!confirm(id+' 크리덴셜을 삭제할까요?'))return;await patchConfig({credentials:[{id,_delete:true}]});});actionCell.append(remove);
    row.append(idCell,labelCell,planCell,capabilityCell,weightCell,enabledCell,previewCell,statusCell,actionCell);body.append(row);
  });
}

function usagePool(title,subtitle,pool,className){
  const value=pool&&Number.isFinite(pool.usedPercent)?Number(pool.usedPercent):null;
  const item=make('div','usage-pool'+(className?' '+className:''));
  const head=make('div','usage-pool-head');
  const name=make('div','usage-pool-name');name.append(make('strong','',title),make('span','',subtitle));
  head.append(name,make('span','usage-pool-value',formatPercent(value)));
  const track=make('div','usage-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',title+' 사용률');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax',String(value===null?100:Math.max(100,value)));
  if(value!==null)track.setAttribute('aria-valuenow',String(value));
  const bar=make('div','usage-bar');bar.style.width=(value===null?0:Math.min(100,value))+'%';track.append(bar);
  const exact=pool&&Number.isFinite(pool.remainingCents)&&Number.isFinite(pool.limitCents)
    ?formatCents(pool.remainingCents)+' 남음 / '+formatCents(pool.limitCents)
    :'정확한 잔량 미제공';
  item.append(head,track,make('div','usage-detail',exact));
  return item;
}

function renderCredentialUsage(){
  const button=$('refreshCredentialUsage');button.disabled=usageLoading||patching;button.textContent=usageLoading?'갱신 중':'새로고침';
  const container=$('credentialUsageList');container.replaceChildren();
  let snapshots=credentialUsageData&&Array.isArray(credentialUsageData.credentials)?credentialUsageData.credentials:[];
  if(usageLoading&&snapshots.length===0&&dashboardData){
    snapshots=joinedCredentials().map(({config})=>({id:config.id,label:config.label,enabled:config.enabled!==false,status:'loading',pools:{cursorModels:{},otherModels:{}}}));
  }
  if(usageLoading&&snapshots.length===0){container.append(make('div','empty','계정 사용량을 불러오는 중입니다.'));return;}
  if(snapshots.length===0){container.append(make('div','empty',credentialUsageError?'사용량을 조회하지 못했습니다.':'표시할 credential 사용량이 없습니다.'));return;}
  const statusLabels={fresh:'최신',stale:'지연됨',unavailable:'조회 불가',loading:'갱신 중'};
  const errorLabels={auth:'인증 실패',protocol:'프로토콜 불일치',upstream:'업스트림 조회 실패'};
  snapshots.forEach(snapshot=>{
    const card=make('article','usage-card'+(snapshot.status==='loading'?' loading':''));
    const head=make('div','usage-card-head');
    const account=make('div','usage-account');account.append(make('strong','',snapshot.label||'Credential'),make('code','',snapshot.id));
    const meta=make('div','usage-meta');
    if(snapshot.plan&&snapshot.plan.name)meta.append(make('span','usage-chip',snapshot.plan.name));
    if(snapshot.plan&&snapshot.plan.price)meta.append(make('span','usage-chip',snapshot.plan.price));
    meta.append(make('span','usage-chip '+snapshot.status,statusLabels[snapshot.status]||snapshot.status));
    head.append(account,meta);
    const grid=make('div','usage-grid');
    const pools=snapshot.pools||{};
    grid.append(
      usagePool('Cursor Models','Composer · Grok',pools.cursorModels||{},'cursor'),
      usagePool('Other Models','Claude · GPT · Kimi · GLM 등',pools.otherModels||{},'other')
    );
    const foot=make('div','usage-foot');
    if(snapshot.status==='loading')foot.append(make('span','','사용량을 조회하는 중입니다.'));
    if(snapshot.cycle&&snapshot.cycle.resetsAt){const reset=make('span');reset.append(document.createTextNode('다음 리셋 '),make('strong','',formatDateTime(snapshot.cycle.resetsAt)));foot.append(reset);}
    if(snapshot.fetchedAt)foot.append(make('span','', '갱신 '+formatDateTime(snapshot.fetchedAt)));
    if(snapshot.onDemand&&Number.isFinite(snapshot.onDemand.remainingCents))foot.append(make('span','', '온디맨드 '+formatCents(snapshot.onDemand.remainingCents)+' 남음'));
    card.append(head,grid);
    if(foot.childNodes.length)card.append(foot);
    if(snapshot.error)card.append(make('div','usage-error',errorLabels[snapshot.error.kind]||'사용량 조회 실패'));
    container.append(card);
  });
}

function updateCredentialTimes(){
  document.querySelectorAll('[data-credential-status]').forEach(item=>{
    if(item.dataset.enabled==='false')return;
    if(item.dataset.reason==='auth'){item.textContent='인증오류';item.className='bad';return;}
    if(item.dataset.reason==='cooldown'){
      const remaining=Math.max(0,Number(item.dataset.until||0)-Date.now());
      item.textContent=remaining>0?'쿨다운 · '+duration(remaining):'정상';
      item.className=remaining>0?'warn':'good';
    }
  });
}

function familyFor(id){
  const value=String(id).toLowerCase();
  if(value.startsWith('composer-'))return 'composer';
  if(value.startsWith('cursor-grok-')||value.startsWith('grok-'))return 'grok';
  if(value.startsWith('claude-opus-')||value.startsWith('opus-'))return 'opus';
  if(value.startsWith('claude-sonnet-')||value.startsWith('sonnet-'))return 'sonnet';
  if(value.startsWith('claude-fable-')||value.startsWith('fable-'))return 'fable';
  if(value.startsWith('gpt-5.6-'))return 'gpt-5.6';
  if(value.startsWith('kimi-'))return 'kimi';
  if(value.startsWith('glm-'))return 'glm';
  return '기타';
}

function renderModels(){
  if(!dashboardData)return;
  const models=dashboardData.state&&dashboardData.state.models||[];
  const query=$('modelSearch').value.trim().toLowerCase();
  const enabled=models.filter(model=>model.enabled).length;
  const countText='활성 '+enabled+' / 전체 '+models.length;
  setText('modelTotal',countText);setText('modelHeadingCount',countText);
  const grouped=new Map(familyOrder.map(name=>[name,[]]));
  models.forEach(model=>grouped.get(familyFor(model.id)).push(model));
  const container=$('modelGroups');container.replaceChildren();
  let visible=0;
  familyOrder.forEach(family=>{
    const all=grouped.get(family);
    if(!all.length)return;
    const filtered=all.filter(model=>String(model.id).toLowerCase().includes(query));
    if(!filtered.length)return;
    visible+=filtered.length;
    const familyEnabled=all.filter(model=>model.enabled).length;
    const meta=familyMeta[family];
    const details=make('details','family'+(familyEnabled===0?' is-disabled':''));details.open=query.length>0||openFamilies.has(family);details.style.setProperty('--family-accent',meta.accent);
    details.addEventListener('toggle',()=>{if(details.open)openFamilies.add(family);else openFamilies.delete(family);});
    const summary=make('summary');
    const dot=make('span','family-dot');dot.setAttribute('aria-hidden','true');
     const actions=make('div','family-actions');
    const bulkTitle='검색 필터와 관계없이 이 패밀리의 모든 모델에 적용합니다.';
    const enableAll=make('button','family-action','모두 켜기');enableAll.type='button';enableAll.title=bulkTitle;enableAll.dataset.adminControl='';enableAll.disabled=familyEnabled===all.length;enableAll.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();await patchConfig({modelOverrides:Object.fromEntries(all.map(model=>[model.id,true]))});});
    const disableAll=make('button','family-action','모두 끄기');disableAll.type='button';disableAll.title=bulkTitle;disableAll.dataset.adminControl='';disableAll.disabled=familyEnabled===0;disableAll.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();await patchConfig({modelOverrides:Object.fromEntries(all.map(model=>[model.id,false]))});});
    actions.append(enableAll,disableAll);
     summary.append(dot,make('span','family-name',meta.name),make('span','family-count','활성 '+familyEnabled+'/'+all.length));details.append(summary,actions);
    const list=make('div','model-list');
    filtered.forEach(model=>{
      const row=make('div','model-row');
       const name=make('div','model-name');name.append(make('code','',model.id));
       const meta=make('div','model-meta');
       if(model.source==='default')meta.append(make('span','badge','기본값'));
       else meta.append(make('span','badge','재정의'));
       if(model.credentialRequirement==='ultra'){
         const requirement=make('span','badge','Ultra 전용');
         requirement.setAttribute('data-credential-requirement','ultra');
         meta.append(requirement);
       }
      name.append(meta);
      const controls=make('div','model-control');
      if(model.source==='override'){
        const reset=make('button','link','되돌리기');reset.type='button';reset.dataset.adminControl='';reset.addEventListener('click',async()=>{await patchConfig({modelOverrides:{[model.id]:null}});});controls.append(reset);
      }
      controls.append(switchControl(Boolean(model.enabled),false,model.id+' 사용 여부',async event=>{await patchConfig({modelOverrides:{[model.id]:event.currentTarget.checked}});}));
      row.append(name,controls);list.append(row);
    });
    details.append(list);container.append(details);
  });
  if(visible===0)container.append(make('div','empty',query?'검색 결과가 없습니다.':'표시할 모델이 없습니다.'));
}

function renderMaxMode(){
  if(!dashboardData)return;
  const enabled=Boolean(dashboardData.config&&dashboardData.config.maxModeDefault);
  $('maxModeDefault').value=enabled?'on':'off';
  setText('activeMaxMode',enabled?'on':'off');
}

function renderAll(){renderHealth();renderStatus();renderCredentialPolicy();renderCredentials();renderCredentialUsage();renderMaxMode();renderModels();$('app').setAttribute('aria-busy','false');}
function setBusy(value){patching=value;$('app').classList.toggle('busy',value);$('app').setAttribute('aria-busy',String(value));}

async function loadCredentialUsage(force=false){
  usageLoading=true;credentialUsageError='';renderCredentialUsage();
  try{
    credentialUsageData=await fetchJson(force?'/admin/credentials/usage/refresh':'/admin/credentials/usage',{method:force?'POST':'GET'},true);
  }catch(error){
    credentialUsageError=errorMessage(error);
    if(error&&error.status===401)handleAdminError(error);else showToast(credentialUsageError,true);
  }finally{
    usageLoading=false;renderCredentialUsage();
  }
}

async function patchConfig(payload){
  if(patching){showToast('이전 변경을 적용하는 중입니다.');return false;}
  setBusy(true);
  try{
    const fresh=await fetchJson('/admin/config',{method:'PATCH',body:JSON.stringify(payload)},true);
    dashboardData=fresh;
    setBusy(false);
    renderAll();
    hidePageState();
    showToast('변경을 적용했습니다.');
    loadCredentialUsage(false);
    return true;
  }catch(error){
    setBusy(false);
    if(dashboardData)renderAll();
    if(error&&error.status===401)handleAdminError(error);
    else showPageState('변경을 적용하지 못했습니다: '+errorMessage(error),'error');
    showToast(errorMessage(error),true);
    return false;
  }
}

async function loadDashboard(){
  $('app').setAttribute('aria-busy','true');
  const healthRequest=fetchJson('/health').then(value=>{healthData=value;renderHealth();}).catch(()=>{healthData=null;renderHealth();});
  await healthRequest;
  const clientAuthEnabled=!healthData||!healthData.auth||healthData.auth.client_auth_enabled!==false;
  if(clientAuthEnabled&&!apiKey){
    showPageState('관리 API key를 입력하면 설정을 불러옵니다.');
    showAuth();
    $('app').setAttribute('aria-busy','false');
    return;
  }
  try{
    dashboardData=await fetchJson('/admin/config',{},true);
    usageLoading=true;
    renderAll();
    hidePageState();
    void loadCompletionMetrics();
    await loadCredentialUsage(false);
  }catch(error){
    handleAdminError(error);
  }finally{
    $('app').setAttribute('aria-busy','false');
  }
}

$('authForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const value=$('authKey').value.trim();
  if(!value){$('authError').textContent='API key를 입력하세요.';return;}
  storeKey(value);
  $('authDialog').close();
  await loadDashboard();
});
$('authCancel').addEventListener('click',()=>$('authDialog').close());
$('changeKey').addEventListener('click',()=>showAuth());
$('maxModeDefault').addEventListener('change',async event=>{await patchConfig({maxModeDefault:event.currentTarget.value==='on'});});
$('modelSearch').addEventListener('input',renderModels);
$('refreshCredentialUsage').addEventListener('click',async()=>{await loadCredentialUsage(true);});
$('credentialRoutingPolicy').addEventListener('change',async event=>{await patchConfig({credentialPolicy:{routingPolicy:event.currentTarget.value}});});
$('credentialFailoverPolicy').addEventListener('change',async event=>{await patchConfig({credentialPolicy:{failoverOn:event.currentTarget.value}});});
$('addCredential').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget;
  const id=$('credentialId').value.trim();
  const label=$('credentialLabel').value.trim();
  const key=$('credentialKey').value.trim();
  const weight=Number($('credentialWeight').value);
  const plan=$('credentialPlan').value;
  const fableCapability=$('credentialFableCapability').checked;
  if(!id||!key||!Number.isFinite(weight)||weight<=0){showToast('ID, API key, 올바른 가중치를 입력하세요.',true);return;}
  const credential={id,apiKey:key,weight,enabled:true,plan,capabilities:{fable:plan==='ultra'&&fableCapability}};
  if(label)credential.label=label;
  if(await patchConfig({credentials:[credential]})){form.reset();$('credentialFableCapability').disabled=true;}
});
$('credentialPlan').addEventListener('change',event=>{$('credentialFableCapability').checked=event.currentTarget.value==='ultra';$('credentialFableCapability').disabled=event.currentTarget.value!=='ultra';});
document.addEventListener('keydown',event=>{if(event.key==='Escape')hideToast();});
${overviewScript}
setInterval(updateCredentialTimes,1000);
loadDashboard();
</script>
</body>
</html>`;
}
