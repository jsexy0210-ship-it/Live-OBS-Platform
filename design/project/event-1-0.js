/* EVT-1.0-r1 DRAFT / PROPOSED. Local design fixtures only; no network, storage, real draw or fulfillment. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const all = (s) => [...document.querySelectorAll(s)];
  const show = (s, visible) => all(s).forEach(e => { e.hidden = !visible; });
  const set = (s, value) => all(s).forEach(e => { e.textContent = value; });
  const participants = Array.from({ length: 6 }, (_, i) => ({name:`참여자 ${String(i+1).padStart(2,'0')}`, via:i%2?'QR · 휴대폰':'유튜브 채팅', time:`2026.10.06 21:3${i}`}));
  const labels = {draw:'무작위 추첨','roulette-participant':'참여자 룰렛','roulette-item':'항목 룰렛',ladder:'사다리'};
  if ($('.evt-admin')) {
    let frozen = false, test = true, pending = null, running = false, timer = null, revealed = 1, empty = false, realCompleted = false, cancelled = false, memoRow = null;
    let prize = '스타라이트 1팩', winners = 3, kind = 'draw', title = '별빛 선물 이벤트';
    let keyword = '별빛참여';
    const fixtureResult = ['참여자 02','참여자 04','참여자 06','참여자 01','참여자 03','참여자 05'];
    let rows = [{ title:'지난 방송 선물', names:'참여자 04', date:'2026.10.05 21:42', type:'실제 진행', prize:'크리스탈 1팩', state:'지급 대기' }];
    const toast = value => set('[data-toast]', value);
    function tab(id) {
      all('[role=tabpanel]').forEach(e => { e.hidden = e.id !== id; });
      all('[role=tab]').forEach(e => {e.setAttribute('aria-selected', String(e.dataset.tab === id));e.tabIndex=e.dataset.tab===id?0:-1;});
    }
    all('[data-tab]').forEach(e => e.addEventListener('click', () => tab(e.dataset.tab)));
    all('[role=tab]').forEach((e,i,items) => e.addEventListener('keydown',event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?items.length-1:(i+(event.key==='ArrowLeft'?-1:1)+items.length)%items.length;
      items[index].focus();tab(items[index].dataset.tab);
    }));
    function renderParticipants(search='') {
      const visible = empty ? [] : participants.filter(p => p.name.includes(search));
      const table=$('[data-participants]'), cards=$('[data-participant-cards]');
      table.replaceChildren();cards.replaceChildren();
      visible.forEach((p,i) => {
        const tr=document.createElement('tr');
        [p.name, String(i+1),p.via,p.time].forEach((v,index)=>{const td=document.createElement('td');td.textContent=v;if(index===0)td.className='l';tr.append(td);});table.append(tr);
        const c=document.createElement('div');c.className='event-mcard';const b=document.createElement('b');b.textContent=p.name;const sub=document.createElement('span');sub.className='nt';sub.textContent=`${p.via} · ${p.time}`;c.append(b,sub);cards.append(c);
      });
      if (!visible.length) {const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=4;td.textContent=empty?'참여자가 없습니다.':'검색 결과가 없습니다.';tr.append(td);table.append(tr);cards.textContent=td.textContent;}
      set('[data-participant-count]', `참여자 ${empty?0:6}명`);
    }
    function state() {
      set('[data-status]', frozen?'마감':'참여 중');set('[data-run-status]', frozen?'명단 확정':'마감 전');
      set('[data-freeze-label]',frozen?`마감 · 확정 ${empty?0:6}명`:'참여 마감이 필요합니다.');
      const noParticipants = kind !== 'roulette-item' && empty;
      $('[data-action=real]').disabled=!frozen || noParticipants || running || realCompleted || cancelled;
      $('[data-action=test]').disabled=running || cancelled;
      $('[data-action=close]').disabled=frozen;
      show('[data-closed-note]', frozen);
      set('[data-closed-note]',empty?'참여자가 없습니다. 참여자 명단으로 실제 진행할 수 없습니다.':`참여가 마감되었습니다. 확정된 6명으로 진행합니다. 이후 채팅과 QR 참여는 받지 않습니다.`);
      all('#setup input,#setup textarea,#setup select').forEach(e => {e.disabled=frozen;});
      $('[data-action=open]').disabled=frozen;
      $('[data-action=save]').disabled=frozen;all('[data-item-add],[data-item-delete]').forEach(e=>{e.disabled=frozen;});$('[data-action=cancel]').disabled=running || cancelled;show('[data-cancelled]',cancelled);
      set('[data-candidates]', `${empty?0:6}명 · ${$('#exclude-winners').checked?'기존 당첨자 제외':'기존 당첨자 포함'} · ${$('#allow-repeat').checked?'중복 당첨 허용':'중복 당첨 안 함'}`);
    }
    function history(filter='전체') {
      const visible=rows.filter(r=>filter==='전체'||r.type===filter);
      $('[data-history]').replaceChildren();$('[data-history-cards]').replaceChildren();
      visible.forEach(r=>{
        const tr=document.createElement('tr');const name=document.createElement('td');name.className='l';const titleButton=document.createElement('button');titleButton.className='lk';titleButton.type='button';titleButton.style.cssText='border:0;background:transparent;font:inherit;text-align:left;cursor:pointer';titleButton.textContent=`${r.title} · ${r.names}`;titleButton.addEventListener('click',()=>{memoRow=r;$('#fulfillment-memo').value=r.memo||'';$('#fulfillment-memo').focus();toast(`${r.names} 결과의 메모를 작성합니다.`);});name.append(titleButton);tr.append(name);
        [r.date,r.type,r.prize,r.state].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td);});
        const action=document.createElement('td');tr.append(action);
        const card=document.createElement('div');card.className='event-mcard';const b=document.createElement('b');b.textContent=`${r.title} · ${r.names}`;b.tabIndex=0;b.addEventListener('click',()=>{memoRow=r;$('#fulfillment-memo').value=r.memo||'';$('#fulfillment-memo').focus();});card.append(b);
        const meta=document.createElement('span');meta.className='nt';meta.textContent=`${r.date} · ${r.type} · ${r.prize}`;card.append(meta);
        if (r.type==='실제 진행' && r.state!=='지급 없음') {
          const select=document.createElement('select');select.className='i fulfillment';select.setAttribute('aria-label',`${r.names} 경품 지급 상태`);
          ['지급 대기','지급 중','지급 완료','확인 필요'].forEach(v=>{const o=document.createElement('option');o.textContent=v;o.selected=v===r.state;select.append(o);});
          const selectMobile=select.cloneNode(true);
          function update(value){r.state=value;history(filter);toast('지급 상태를 변경했습니다.');}
          select.addEventListener('change',()=>update(select.value));selectMobile.addEventListener('change',()=>update(selectMobile.value));action.append(select);card.append(selectMobile);
        } else {action.textContent='—';const status=document.createElement('span');status.className='tag y';status.textContent='테스트 · 지급 없음';card.append(status);}
        $('[data-history]').append(tr);$('[data-history-cards]').append(card);
      });show('[data-history-empty]',!visible.length);
    }
    function readSettings() {
      title=$('#event-title').value.trim();keyword=$('#event-keyword').value;
      if (!title || !keyword.trim()) {toast('이벤트 이름과 참여 키워드를 입력해 주십시오.');return false;}
      winners=Number($('#event-winners').value);kind=$('#event-kind').value;prize=$('#event-prize').value.trim()||'경품';
      if (!Number.isInteger(winners)||winners<1){toast('당첨 인원을 확인해 주십시오.');return false;}
      set('[data-kind-label]',labels[kind]);set('[data-preview-title]',title);
      const reveal=document.querySelector('input[name=reveal]:checked').value;
      set('[data-reveal-label]',reveal==='all'?'한 번에 공개':'한 명씩 공개');
      if(kind==='ladder'){const count=Number($('#ladder-count').value);const slots=$('#ladder-results').value.split('\n').map(v=>v.trim()).filter(Boolean);if(!Number.isInteger(count)||count<2||count!==6){toast('사다리 인원은 확정 참여자 수와 같아야 합니다.');return false;}if(slots.length>count){toast('결과 슬롯이 참여 인원보다 많습니다. 슬롯 수를 확인해 주십시오.');return false;}if(slots.length<count){confirm('ladder-fill','부족한 결과를 미당첨으로 추가하시겠습니까?',`참여 인원 ${count}명, 결과 ${slots.length}개입니다. 부족한 ${count-slots.length}개를 미당첨으로 채웁니다.`,'미당첨 추가');return false;}}
      return true;
    }
    function confirm(action,titleText,bodyText,label) {
      pending=action;set('[data-confirm-title]',titleText);set('[data-confirm-body]',bodyText);set('[data-confirm-accept]',label);$('[data-confirm]').showModal();
    }
    all('[data-confirm-cancel]').forEach(e=>e.addEventListener('click',()=>{$('[data-confirm]').close();pending=null;}));
    $('[data-confirm-accept]').addEventListener('click',()=>{
      $('[data-confirm]').close();const action=pending;pending=null;
      if (action==='close') {frozen=true;state();set('[data-preview-status]','참여가 마감됐어요');show('[data-qr-preview]',false);toast('참여를 마감했습니다. 명단이 확정되었습니다.');}
      if (action==='real') start(false);
      if(action==='ladder-fill'){const count=Number($('#ladder-count').value),slots=$('#ladder-results').value.split('\n').map(v=>v.trim()).filter(Boolean);while(slots.length<count)slots.push('미당첨');$('#ladder-results').value=slots.join('\n');set('[data-ladder-slot-count]',`결과 ${slots.length}개 · 참여 인원 ${count}명 · 슬롯 수 일치`);toast('미당첨 슬롯을 추가했습니다. 설정을 확인해 주십시오.');}
      if(action==='cancel'){cancelled=true;state();set('[data-preview-status]','이벤트가 취소됐어요');show('[data-qr-preview]',false);toast('이벤트를 취소했습니다. 기록된 결과는 유지됩니다.');}
    });
    function resultNames() {if(kind==='roulette-item')return[$('#event-items').value.split('\n').map(v=>v.trim()).filter(Boolean)[0]||'스타라이트 1팩'];if(kind==='ladder'){const slots=$('#ladder-results').value.split('\n').map(v=>v.trim()).filter(Boolean);return participants.map((p,i)=>`${p.name} — ${slots[i]||'미당첨'}`);}return Array.from({length:winners},(_,i)=>fixtureResult[i%fixtureResult.length]);}
    function renderResult() {
      const names=resultNames();set('[data-result-name]',names.slice(0,revealed).join(' · '));set('[data-result-prize]',kind==='roulette-item'?'선택된 항목':kind==='ladder'?'참여자별 결과':prize);set('[data-reveal-progress]',`${Math.min(revealed,names.length)} / ${names.length}${kind==='roulette-item'?'개':'명'} 공개`);
      $('[data-action=next]').disabled=revealed>=names.length;$('[data-action=all]').disabled=revealed>=names.length;
    }
    function start(isTest) {
      if (!readSettings()) return;
      if (!isTest && (!frozen || running || (kind!=='roulette-item' && empty))) return;
      // Six display fixtures demonstrate layout; they are not a product participation limit.
      if (kind!=='roulette-item' && kind!=='ladder' && winners>6 && !$('#allow-repeat').checked) {toast('당첨 인원이 확정 참여자 수보다 많습니다. 설정을 확인해 주십시오.');return;}
      clearInterval(timer);test=isTest;running=true;state();show('[data-test]',test);show('[data-run-stage]',true);show('[data-countdown]',true);show('[data-progress]',false);show('[data-result]',false);show('[data-run-error]',false);
      set('[data-result-mode]',test?'테스트 결과 · 경품 지급 없음':'당첨 결과');show('[data-action=reset]',test);
      let count=Math.max(0,Number($('#event-countdown').value)||0);set('[data-count]',String(count));set('[data-preview-status]',test?'테스트 · 곧 시작해요':'곧 시작해요');
      function progress() {clearInterval(timer);show('[data-countdown]',false);show('[data-progress]',true);show('[data-wheel]',kind.includes('roulette'));show('[data-ladder]',kind==='ladder');show('[data-drawing]',kind==='draw');set('[data-preview-status]',`${test?'테스트 · ':''}진행하고 있어요`);
        timer=setTimeout(()=>{running=false;show('[data-progress]',false);show('[data-result]',true);revealed=document.querySelector('input[name=reveal]:checked').value==='all'?resultNames().length:1;renderResult();state();set('[data-preview-status]',test?'테스트 결과예요':'당첨 결과예요');
          if (!test) realCompleted=true;
          resultNames().forEach(name=>rows.unshift({title,names:name,date:'2026.10.06 21:42',type:test?'테스트':'실제 진행',prize:kind==='roulette-item'?'선택된 항목':kind==='ladder'?'참여자별 결과':prize,state:test||kind==='roulette-item'?'지급 없음':'지급 대기'}));state();
          history();toast(test?'테스트가 끝났습니다. 실제 경품은 지급되지 않습니다.':'결과가 기록되었습니다.');
        },1200);
      }
      if (!count) progress();else timer=setInterval(()=>{count--;set('[data-count]',String(count));if(count<=0)progress();},1000);
    }
    all('[data-action]').forEach(e=>e.addEventListener('click',()=>{
      const action=e.dataset.action;
      if (action==='cancel') confirm('cancel','이벤트를 취소하시겠습니까?','새 참여와 진행을 중단합니다. 이미 기록된 결과는 바뀌지 않습니다.','이벤트 취소');
      if(action==='memo'){memoRow=memoRow||rows[0];if(memoRow){memoRow.memo=$('#fulfillment-memo').value;toast('메모를 저장했습니다. 방송에는 표시되지 않습니다.');}}
      if (action==='save') {if(readSettings())toast('설정을 저장했습니다.');}
      if (action==='open' && readSettings()) {tab('participants');set('[data-preview-status]','참여를 받고 있어요');toast('참여를 열었습니다.');}
      if (action==='close') confirm('close','참여를 마감하시겠습니까?','마감하면 참여 명단이 확정됩니다. 이후에는 참여할 수 없습니다.','참여 마감');
      if (action==='test') start(true);
      if (action==='real') confirm('real','실제 진행을 시작하시겠습니까?',`확정 명단과 설정으로 ${labels[kind]}을 시작합니다. 결과가 기록됩니다. 테스트가 아닙니다.`,'실제 진행');
      if (action==='next') {revealed++;renderResult();}
      if (action==='all') {revealed=resultNames().length;renderResult();}
      if (action==='reset') {show('[data-test]',false);show('[data-run-stage]',false);set('[data-preview-status]','참여가 마감됐어요');}
      if (action==='recover') {show('[data-run-error]',false);show('[data-run-stage]',true);show('[data-countdown]',false);show('[data-progress]',false);show('[data-result]',true);renderResult();toast('이미 기록된 결과를 확인했습니다. 다시 진행하지 않습니다.');}
      if (action==='filter') history($('#history select').value);
      if (action==='filter-reset') {$('#history select').value='전체';history();}
    }));
    $('[data-search]').addEventListener('click',()=>renderParticipants($('.event-search input').value.trim()));
    all('[data-review]').forEach(e=>e.addEventListener('click',()=>{
      clearInterval(timer);running=false;
      if(e.dataset.review==='closed'){frozen=true;empty=false;tab('participants');}
      if(e.dataset.review==='empty'){empty=true;frozen=true;tab('participants');}
      if(e.dataset.review==='error'){tab('run');show('[data-run-error]',true);show('[data-run-stage]',false);$('[data-action=real]').disabled=true;return;}
      if(e.dataset.review==='restore'){frozen=false;empty=false;realCompleted=false;cancelled=false;show('[data-test]',false);show('[data-run-stage]',false);show('[data-run-error]',false);tab('setup');}
      renderParticipants();state();
    }));
    function mode(){kind=$('[data-kind]').value;set('[data-kind-label]',labels[kind]);all('[data-mode-settings]').forEach(e=>{e.hidden=e.dataset.modeSettings!==kind;});state();}
    $('[data-kind]').addEventListener('change',mode);
    function itemEditor(){const items=$('#event-items').value.split('\n').map(v=>v.trim()).filter(Boolean);const wrap=$('[data-item-editor]');wrap.replaceChildren();items.forEach((v,i)=>{const line=document.createElement('div');line.className='field-line';const input=document.createElement('input');input.className='i';input.style.cssText='flex:1;width:auto';input.value=v;input.setAttribute('aria-label',`항목 ${i+1}`);input.addEventListener('change',()=>{items[i]=input.value.trim();$('#event-items').value=items.filter(Boolean).join('\n');});const del=document.createElement('button');del.className='b';del.type='button';del.dataset.itemDelete='';del.textContent='삭제';del.setAttribute('aria-label',`항목 ${i+1} 삭제`);del.addEventListener('click',()=>{items.splice(i,1);$('#event-items').value=items.join('\n');itemEditor();});line.append(input,del);wrap.append(line);});state();}
    $('[data-item-add]').addEventListener('click',()=>{const value=$('[data-new-item]').value.trim();if(value){$('#event-items').value+='\n'+value;$('[data-new-item]').value='';itemEditor();}});
    itemEditor();mode();
    $('[data-create]')?.addEventListener('click',()=>{frozen=false;empty=false;realCompleted=false;cancelled=false;state();$('#event-title').value='';$('#event-title').focus();toast('새 이벤트를 설정해 주십시오.');});
    $('[data-edit]')?.addEventListener('click',()=>{frozen=false;state();$('#event-title').focus();});
    renderParticipants();history();state();
  }
  if ($('.evt-join')) {
    function joinState(value){all('[data-join-state]').forEach(e=>{e.hidden=e.dataset.joinState!==value;});set('[data-join-tag]',{open:'참여 중',joined:'참여 완료',closed:'마감',countdown:'곧 시작',progress:'진행 중',result:'결과 공개',waiting:'대기',expired:'종료',cancelled:'취소',unavailable:'확인 중'}[value]);}
    $('[data-join-form]').addEventListener('submit',e=>{e.preventDefault();const value=$('[data-join-nickname]').value.trim();if(!value){show('[data-join-error]',true);return;}set('[data-joined-nickname]',value);joinState('joined');});
    $('[data-join-review]').addEventListener('change',e=>joinState(e.target.value));
    $('[data-join-review-test]').addEventListener('change',e=>show('[data-join-test]',e.target.checked));
    all('[data-join-refresh]').forEach(e=>e.addEventListener('click',()=>joinState('joined')));
    $('[data-join-back]')?.addEventListener('click',()=>{if(history.length>1)history.back();else joinState('waiting');});
  }
  if ($('[data-overlay-root]')) {
    function overlay(){
      const state=$('[data-overlay-state]').value,kind=$('[data-overlay-kind]').value;
      all('[data-o]').forEach(e=>{e.hidden=e.dataset.o!==state;});
      show('[data-overlay-draw]',kind==='draw');show('[data-overlay-wheel]',kind.includes('roulette'));show('[data-overlay-ladder]',kind==='ladder');
      set('[data-overlay-kind-label]',kind==='ladder'?'사다리를 따라가요':kind.includes('roulette')?'룰렛을 돌리고 있어요':'추첨하고 있어요');
      const allReveal=$('[data-overlay-reveal-select]').value==='all';set('[data-overlay-result]',kind==='roulette-item'?'스타라이트 1팩':allReveal?'참여자 02 · 04 · 06':'참여자 02');
      show('[data-overlay-ladder-results]',kind==='ladder'&&allReveal);show('[data-overlay-result]',!(kind==='ladder'&&allReveal));show('[data-overlay-prize]',!(kind==='ladder'&&allReveal));set('[data-overlay-reveal]',kind==='roulette-item'?'항목 선택 결과':kind==='ladder'?allReveal?'6 / 6명 공개':'1 / 6명 공개':allReveal?'3 / 3명 공개':'1 / 3명 공개');
      show('[data-overlay-test]',$('[data-overlay-review-test]').checked);
      $('[data-overlay-root]').classList.toggle('portrait',$('[data-overlay-ratio]').value==='portrait');
      $('[data-overlay-root]').classList.toggle('bg-sample',!$('[data-overlay-transparent]').checked);
    }
    all('.evt-review select,.evt-review input').forEach(e=>e.addEventListener('change',overlay));overlay();
  }
})();
