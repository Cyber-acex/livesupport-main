(() => {
  const STORAGE_KEY = 'cyber_ops_dashboard_v1';

  // Demo initial data
  const defaultState = {
    salesToday: 1248.5,
    activeOrders: 3,
    menu: [
      {id:1,name:'Neon Ramen',price:12.5,category:'Noodles',stock:24,ordersToday:48,prepTime:12,available:true,img:'https://images.unsplash.com/photo-1604908177522-1f9b0d4e0b11?auto=format&fit=crop&w=800&q=60'},
      {id:2,name:'Glow Burger',price:15.0,category:'Mains',stock:6,ordersToday:22,prepTime:10,available:true,img:'https://images.unsplash.com/photo-1544378736-06d6a4fa3f53?auto=format&fit=crop&w=800&q=60'},
      {id:3,name:'Aether Salad',price:9.0,category:'Sides',stock:2,ordersToday:6,prepTime:5,available:true,img:'https://images.unsplash.com/photo-1542444563-2a5e2f0a7f40?auto=format&fit=crop&w=800&q=60'},
      {id:4,name:'Binary Tacos',price:11.0,category:'Tacos',stock:0,ordersToday:0,prepTime:8,available:false,img:'https://images.unsplash.com/photo-1600891964599-f61ba0e24092?auto=format&fit=crop&w=800&q=60'},
    ],
    tables: [
      {id:1,num:1,x:20,y:20,status:'vacant',guests:0,waiter:'Alex',occupiedSince:null,reservedFor:null,total:0},
      {id:2,num:2,x:140,y:20,status:'occupied',guests:3,waiter:'Jin',occupiedSince:Date.now()-600000,total:42.5},
      {id:3,num:3,x:260,y:20,status:'reserved',guests:4,waiter:'Sam',reservedFor:Date.now()+3600000,total:0}
    ]
  };

  // state
  let state = loadState();

  // DOM refs
  const menuGrid = document.getElementById('menuGrid');
  const addItemBtn = document.getElementById('addItemBtn');
  const editDrawer = document.getElementById('editDrawer');
  const itemForm = document.getElementById('itemForm');
  const closeDrawer = document.getElementById('closeDrawer');
  const drawerTitle = document.getElementById('drawerTitle');
  const deleteItemBtn = document.getElementById('deleteItem');
  const categoryFilter = document.getElementById('categoryFilter');
  const salesTodayEl = document.getElementById('salesToday');
  const activeOrdersEl = document.getElementById('activeOrders');
  const floorMap = document.getElementById('floorMap');
  const presenceList = document.getElementById('presenceList');
  const profileBtn = document.getElementById('profileBtn');
  const profileDropdown = document.getElementById('profileDropdown');
  const profileNameEl = document.getElementById('profileName');
  const avatarImgEl = document.querySelector('.avatar-sm-img');
  const avatarLetterEl = document.querySelector('.avatar-sm');

  let editingId = null;

  function loadState(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return defaultState;
  }
  function saveState(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // Particles background simple grid + drifting dots
  function initParticles(){
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const wrap = document.getElementById('particles');
    if(!wrap) return;
    wrap.appendChild(c);
    function resize(){c.width=wrap.clientWidth;c.height=wrap.clientHeight;}
    window.addEventListener('resize',resize);resize();
    const dots=[];for(let i=0;i<80;i++)dots.push({x:Math.random()*c.width,y:Math.random()*c.height,r:Math.random()*1.8+0.2,vx:(Math.random()-0.5)*0.2,vy:(Math.random()-0.5)*0.2});
    function tick(){ctx.clearRect(0,0,c.width,c.height);ctx.globalAlpha=0.6;for(const d of dots){d.x+=d.vx;d.y+=d.vy; if(d.x<0)d.x=c.width; if(d.x>c.width)d.x=0; if(d.y<0)d.y=c.height; if(d.y>c.height)d.y=0;ctx.fillStyle='rgba(0,230,255,0.06)';ctx.beginPath();ctx.arc(d.x,d.y,d.r,0,Math.PI*2);ctx.fill()}requestAnimationFrame(tick)}
    tick();
  }

  function render(){
    renderMenu();
    renderFloor();
    updateInsights();
    populateCategories();
    saveState();
  }

  function populateCategories(){
    const set = new Set(state.menu.map(m=>m.category));
    if(categoryFilter) categoryFilter.innerHTML='<option value="all">All Categories</option>'+
      Array.from(set).map(c=>`<option value="${c}">${c}</option>`).join('');
  }

  function renderMenu(){
    if(!menuGrid) return;
    const filter = categoryFilter && categoryFilter.value || 'all';
    menuGrid.innerHTML='';
    const list = state.menu.filter(m=>filter==='all'||m.category===filter);
    list.forEach(renderCard);
  }

  function renderCard(item){
    const div = document.createElement('div');div.className='menu-card glass-card';
    div.innerHTML = `
      <div class="food-img" style="background-image:url('${item.img}')"></div>
      <div class="scan-overlay"></div>
      <div class="mt-3">
        <div class="flex justify-between items-center">
          <div>
            <div class="text-lg font-semibold">${item.name}</div>
            <div class="text-sm text-gray-300">${item.category} • ${item.prepTime}m</div>
          </div>
          <div class="text-lg font-bold">$${item.price.toFixed(2)}</div>
        </div>
        <div class="card-footer">
          <div style="width:60%">
            <div class="stock-bar mt-2"><i style="width:${Math.max(0,(item.stock/30)*100)}%"></i></div>
          </div>
          <div class="flex flex-col items-end">
            <div class="status-pill ${item.stock===0? 'status-sold' : item.stock<5? 'status-low': 'status-available'}">${item.stock===0? 'Sold Out': item.stock<5? 'Low': 'Available'}</div>
            <div class="text-xs text-gray-400 mt-1">${item.ordersToday} orders</div>
          </div>
        </div>
        <div class="flex gap-2 mt-3">
          <button class="magnetic-btn btn-edit" data-id="${item.id}">Edit</button>
          <button class="magnetic-btn btn-toggle" data-id="${item.id}">${item.available? 'Disable':'Enable'}</button>
        </div>
      </div>
    `;

    div.addEventListener('mousemove', e=>{
      const r = div.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width/2))/r.width*10;
      const dy = (e.clientY - (r.top + r.height/2))/r.height*10;
      div.style.transform = `translateY(-6px) rotateX(${ -dy }deg) rotateY(${dx}deg)`;
    });
    div.addEventListener('mouseleave', ()=>{div.style.transform='';});

    div.querySelector('.btn-edit').addEventListener('click', ()=>openDrawer(item.id));
    div.querySelector('.btn-toggle').addEventListener('click', ()=>{toggleAvailability(item.id);});

    menuGrid.appendChild(div);
    if(item.ordersToday>30){ div.style.boxShadow='0 10px 40px rgba(193,107,255,0.12)'; }
  }

  function openDrawer(id){ editingId = id||null; const data = state.menu.find(m=>m.id===id) || {name:'',price:0,category:'',stock:0,prepTime:10,img:''}; drawerTitle.textContent = id? 'Edit Item':'Add Item'; itemForm.name.value = data.name||''; itemForm.price.value = data.price||''; itemForm.category.value = data.category||''; itemForm.stock.value = data.stock||''; itemForm.prepTime.value = data.prepTime||''; editDrawer.classList.add('open'); }
  function closeDrawerFn(){ editingId=null; editDrawer.classList.remove('open'); }
  function saveForm(e){ e.preventDefault(); const f = itemForm; const payload = {name:f.name.value,price:parseFloat(f.price.value)||0,category:f.category.value||'Uncategorized',stock:parseInt(f.stock.value)||0,prepTime:parseInt(f.prepTime.value)||0,img:'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=60'}; if(editingId){ const idx = state.menu.findIndex(m=>m.id===editingId); state.menu[idx] = {...state.menu[idx],...payload}; } else { const id = Date.now(); state.menu.unshift({id,...payload,ordersToday:0,available:true}); } render(); closeDrawerFn(); }
  function toggleAvailability(id){ const it = state.menu.find(m=>m.id===id); if(!it) return; it.available = !it.available; if(it.stock===0) it.available=false; render(); }
  function deleteItem(){ if(!editingId) return; state.menu = state.menu.filter(m=>m.id!==editingId); render(); closeDrawerFn(); }

  function renderFloor(){ if(!floorMap) return; floorMap.innerHTML=''; state.tables.forEach(t=>{ const el = document.createElement('div'); el.className='table-card'; el.dataset.id=t.id; el.draggable=true; el.innerHTML = `<div class=num>Table ${t.num}</div><div class=text-xs mt-1>${t.guests} pax</div>`; if(t.status==='vacant') el.classList.add('pulse-vacant'); if(t.status==='occupied') el.classList.add('pulse-occupied'); if(t.status==='reserved') el.classList.add('pulse-reserved'); el.addEventListener('click', ()=>{ if(t.status==='vacant'){ occupyTable(t.id); } else if(t.status==='occupied'){ t.status='vacant'; t.occupiedSince=null; } else if(t.status==='reserved'){ t.status='occupied'; t.occupiedSince=Date.now(); } render(); }); el.addEventListener('dragstart', ev=>{ev.dataTransfer.setData('text/plain',t.id)}); floorMap.appendChild(el); }); if(!floorMap) return; floorMap.addEventListener('dragover', e=>e.preventDefault()); floorMap.addEventListener('drop', e=>{ e.preventDefault(); const id = parseInt(e.dataTransfer.getData('text/plain')); const t = state.tables.find(x=>x.id===id); if(!t) return; const ripple = document.createElement('div'); ripple.style.position='absolute'; ripple.style.left = (e.offsetX-40)+'px'; ripple.style.top=(e.offsetY-40)+'px'; ripple.style.width='80px'; ripple.style.height='80px'; ripple.style.borderRadius='50%'; ripple.style.background='rgba(0,240,255,0.06)'; ripple.style.zIndex='50'; floorMap.appendChild(ripple); setTimeout(()=>ripple.remove(),600); render(); }); }

  function occupyTable(id){ const t = state.tables.find(x=>x.id===id); if(!t) return; t.status='occupied'; t.occupiedSince = Date.now(); t.guests = Math.max(1,t.guests); t.total = 0; const burst = document.createElement('div'); burst.className='glass-pill'; burst.style.position='absolute'; burst.style.left='50%'; burst.style.top='10px'; burst.textContent='Occupied'; document.body.appendChild(burst); if(window.anime) anime({targets:burst,translateY:[-20,0],opacity:[0,1],duration:700,easing:'easeOutCubic',complete:()=>{setTimeout(()=>anime({targets:burst,opacity:0,duration:400,complete:()=>burst.remove()}),600)}}); }

  function updateInsights(){ if(salesTodayEl) salesTodayEl.textContent = '$'+(state.salesToday||0).toFixed(2); if(activeOrdersEl) activeOrdersEl.textContent = (state.activeOrders||0); }

  function showNotification({title, body, timeout = 3500, audioUrl=null} = {}){ const n = document.createElement('div'); n.className='floating-notification'; n.innerHTML = `<div class="title">${title}</div><div class="body text-sm text-gray-300">${body||''}</div>`; document.body.appendChild(n); if(window.anime) anime({targets:n,opacity:[0,1],translateX:[20,0],duration:400,easing:'easeOutCubic'}); if(audioUrl){ try{ const a = new Audio(audioUrl); a.play().catch(()=>{}); }catch(e){} } setTimeout(()=>{ if(window.anime) anime({targets:n,opacity:0,translateX:20,duration:300,easing:'easeInCubic',complete:()=>n.remove()}) else n.remove(); }, timeout); }

  function updatePresence(list){ if(!presenceList) return; presenceList.innerHTML=''; list.slice(0,6).forEach(p => { const el = document.createElement('div'); el.className='presence-pill'; el.textContent = p.name || ('User '+p.userId); presenceList.appendChild(el); }); }

  function initSocket(){ if(typeof io === 'undefined') return; const socket = io(); socket.on('connect', ()=>{ console.log('Socket connected', socket.id); socket.emit('agent:register', { userId: 'ops_demo', name: 'Ops (Dashboard)', role: 'agent' }); }); socket.on('presenceUpdate', (list)=>{ updatePresence(list); }); socket.on('newMessage', (payload)=>{ showNotification({title:'New Message', body:payload.message||'Message received'}); state.activeOrders = (state.activeOrders||0) + 1; render(); }); socket.on('ticketCreated', (ticket)=>{ showNotification({title:'Ticket Created', body:`#${ticket.id} ${ticket.subject||''}`}); }); socket.on('escalationRaised', (data)=>{ showNotification({title:'Escalation', body:`Conversation ${data.conversationId} escalated`}); const vacant = state.tables.find(t=>t.status==='vacant'); if(vacant){ vacant.status='occupied'; vacant.occupiedSince=Date.now(); render(); } }); socket.on('escalationAssigned', (data)=>{ showNotification({title:'Escalation Assigned', body:`Assigned to ${data.assignedStaffId||'staff'}` , audioUrl: data.audioUrl || null}); if(data.audioUrl){ try{ new Audio(data.audioUrl).play().catch(()=>{}); }catch(e){} } }); socket.on('handoffAlert', (d)=>{ showNotification({title:'Handoff Alert', body:`Handoff: ${d.conversationId||''}`}); }); socket.on('disconnect', ()=>{ console.log('Socket disconnected'); }); }

  // event bindings
  if(addItemBtn) addItemBtn.addEventListener('click', ()=>openDrawer());
  if(closeDrawer) closeDrawer.addEventListener('click', closeDrawerFn);
  if(itemForm) itemForm.addEventListener('submit', saveForm);
  if(deleteItemBtn) deleteItemBtn.addEventListener('click', deleteItem);
  if(categoryFilter) categoryFilter.addEventListener('change', renderMenu);

  // profile initializer
  (function initProfile(){ try{ const name = localStorage.getItem('profileName') || 'Ops'; const avatar = localStorage.getItem('avatarUrl'); if(profileNameEl) profileNameEl.textContent = name; if(avatarImgEl && avatar){ avatarImgEl.src = avatar; avatarImgEl.style.display = 'inline-block'; if(avatarLetterEl) avatarLetterEl.style.display = 'none'; } else if(avatarLetterEl) avatarLetterEl.textContent = (name||'O').charAt(0).toUpperCase(); }catch(e){} if(profileBtn && profileDropdown){ profileBtn.addEventListener('click', ()=>{ const open = profileDropdown.style.display === 'block'; profileDropdown.style.display = open ? 'none' : 'block'; profileBtn.setAttribute('aria-expanded', String(!open)); }); document.addEventListener('click', (ev)=>{ if(!profileBtn.contains(ev.target) && !profileDropdown.contains(ev.target)){ profileDropdown.style.display = 'none'; profileBtn.setAttribute('aria-expanded','false'); } }); } })();

  // init
  initParticles(); render(); initSocket();

})();
(() => {
  const STORAGE_KEY = 'cyber_ops_dashboard_v1';

  // Demo initial data
  const defaultState = {
    salesToday: 1248.5,
    activeOrders: 3,
    menu: [
      {id:1,name:'Neon Ramen',price:12.5,category:'Noodles',stock:24,ordersToday:48,prepTime:12,available:true,img:'https://images.unsplash.com/photo-1604908177522-1f9b0d4e0b11?auto=format&fit=crop&w=800&q=60'},
      {id:2,name:'Glow Burger',price:15.0,category:'Mains',stock:6,ordersToday:22,prepTime:10,available:true,img:'https://images.unsplash.com/photo-1544378736-06d6a4fa3f53?auto=format&fit=crop&w=800&q=60'},
      {id:3,name:'Aether Salad',price:9.0,category:'Sides',stock:2,ordersToday:6,prepTime:5,available:true,img:'https://images.unsplash.com/photo-1542444563-2a5e2f0a7f40?auto=format&fit=crop&w=800&q=60'},
      {id:4,name:'Binary Tacos',price:11.0,category:'Tacos',stock:0,ordersToday:0,prepTime:8,available:false,img:'https://images.unsplash.com/photo-1600891964599-f61ba0e24092?auto=format&fit=crop&w=800&q=60'},
    ],
    tables: [
      {id:1,num:1,x:20,y:20,status:'vacant',guests:0,waiter:'Alex',occupiedSince:null,reservedFor:null,total:0},
      {id:2,num:2,x:140,y:20,status:'occupied',guests:3,waiter:'Jin',occupiedSince:Date.now()-600000,total:42.5},
      {id:3,num:3,x:260,y:20,status:'reserved',guests:4,waiter:'Sam',reservedFor:Date.now()+3600000,total:0}
    ]
  };

  // state
  let state = loadState();

  // DOM refs
  const menuGrid = document.getElementById('menuGrid');
  const addItemBtn = document.getElementById('addItemBtn');
  const editDrawer = document.getElementById('editDrawer');
  const itemForm = document.getElementById('itemForm');
  const closeDrawer = document.getElementById('closeDrawer');
  const drawerTitle = document.getElementById('drawerTitle');
  const deleteItemBtn = document.getElementById('deleteItem');
  const categoryFilter = document.getElementById('categoryFilter');
  const salesTodayEl = document.getElementById('salesToday');
  const activeOrdersEl = document.getElementById('activeOrders');
  const floorMap = document.getElementById('floorMap');
  const presenceList = document.getElementById('presenceList');
  const profileBtn = document.getElementById('profileBtn');
  const profileDropdown = document.getElementById('profileDropdown');
  const profileNameEl = document.getElementById('profileName');
  const avatarImgEl = document.querySelector('.avatar-sm-img');
  const avatarLetterEl = document.querySelector('.avatar-sm');

  let editingId = null;

  function loadState(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return defaultState;
  }
  function saveState(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // Particles background simple grid + drifting dots
  function initParticles(){
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const wrap = document.getElementById('particles');
    wrap.appendChild(c);
    function resize(){c.width=wrap.clientWidth;c.height=wrap.clientHeight;}
    window.addEventListener('resize',resize);resize();
    const dots=[];for(let i=0;i<80;i++)dots.push({x:Math.random()*c.width,y:Math.random()*c.height,r:Math.random()*1.8+0.2,vx:(Math.random()-0.5)*0.2,vy:(Math.random()-0.5)*0.2});
    function tick(){ctx.clearRect(0,0,c.width,c.height);ctx.globalAlpha=0.6;for(const d of dots){d.x+=d.vx;d.y+=d.vy; if(d.x<0)d.x=c.width; if(d.x>c.width)d.x=0; if(d.y<0)d.y=c.height; if(d.y>c.height)d.y=0;ctx.fillStyle='rgba(0,230,255,0.06)';ctx.beginPath();ctx.arc(d.x,d.y,d.r,0,Math.PI*2);ctx.fill()}requestAnimationFrame(tick)}
    tick();
  }

  // Render functions
  function render(){
    renderMenu();
    renderFloor();
    updateInsights();
    populateCategories();
    saveState();
  }

  function populateCategories(){
    const set = new Set(state.menu.map(m=>m.category));
    categoryFilter.innerHTML='<option value="all">All Categories</option>'+
      Array.from(set).map(c=>`<option value="${c}">${c}</option>`).join('');
  }

  function renderMenu(){
    const filter = categoryFilter.value || 'all';
    menuGrid.innerHTML='';
    const list = state.menu.filter(m=>filter==='all'||m.category===filter);
    list.forEach(renderCard);
  }

  function renderCard(item){
    const div = document.createElement('div');div.className='menu-card glass-card';
    div.innerHTML = `
      <div class="food-img" style="background-image:url('${item.img}')"></div>
      <div class="scan-overlay"></div>
      <div class="mt-3">
        <div class="flex justify-between items-center">
          <div>
            <div class="text-lg font-semibold">${item.name}</div>
            <div class="text-sm text-gray-300">${item.category} • ${item.prepTime}m</div>
          </div>
          <div class="text-lg font-bold">$${item.price.toFixed(2)}</div>
        </div>
        <div class="card-footer">
          <div style="width:60%">
            <div class="stock-bar mt-2"><i style="width:${Math.max(0,(item.stock/30)*100)}%"></i></div>
          </div>
          <div class="flex flex-col items-end">
            <div class="status-pill ${item.stock===0? 'status-sold' : item.stock<5? 'status-low': 'status-available'}">${item.stock===0? 'Sold Out': item.stock<5? 'Low': 'Available'}</div>
            <div class="text-xs text-gray-400 mt-1">${item.ordersToday} orders</div>
          </div>
        </div>
        <div class="flex gap-2 mt-3">
          <button class="magnetic-btn btn-edit" data-id="${item.id}">Edit</button>
          <button class="magnetic-btn btn-toggle" data-id="${item.id}">${item.available? 'Disable':'Enable'}</button>
        </div>
      </div>
    `;

    // tilt effect
    div.addEventListener('mousemove', e=>{
      const r = div.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width/2))/r.width*10;
      const dy = (e.clientY - (r.top + r.height/2))/r.height*10;
      div.style.transform = `translateY(-6px) rotateX(${ -dy }deg) rotateY(${dx}deg)`;
    });
    div.addEventListener('mouseleave', ()=>{div.style.transform='';});

    // edit and toggle
    div.querySelector('.btn-edit').addEventListener('click', ()=>openDrawer(item.id));
    div.querySelector('.btn-toggle').addEventListener('click', ()=>{toggleAvailability(item.id);});

    menuGrid.appendChild(div);

    // trending glow if many orders
    if(item.ordersToday>30){
      div.style.boxShadow='0 10px 40px rgba(193,107,255,0.12)';
    }
  }

  function openDrawer(id){
    editingId = id||null;
    const data = state.menu.find(m=>m.id===id) || {name:'',price:0,category:'',stock:0,prepTime:10,img:''};
    drawerTitle.textContent = id? 'Edit Item':'Add Item';
    itemForm.name.value = data.name||'';
    itemForm.price.value = data.price||'';
    itemForm.category.value = data.category||'';
    itemForm.stock.value = data.stock||'';
    itemForm.prepTime.value = data.prepTime||'';
    editDrawer.classList.add('open');
  }

  function closeDrawerFn(){ editingId=null; editDrawer.classList.remove('open'); }

  function saveForm(e){
    e.preventDefault();
    const f = itemForm;
    const payload = {name:f.name.value,price:parseFloat(f.price.value)||0,category:f.category.value||'Uncategorized',stock:parseInt(f.stock.value)||0,prepTime:parseInt(f.prepTime.value)||0,img:'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=60'};
    if(editingId){
      const idx = state.menu.findIndex(m=>m.id===editingId);
      state.menu[idx] = {...state.menu[idx],...payload};
    } else {
      const id = Date.now(); state.menu.unshift({id,...payload,ordersToday:0,available:true});
    }
    render(); closeDrawerFn();
  }

  function toggleAvailability(id){
    const it = state.menu.find(m=>m.id===id); if(!it) return; it.available = !it.available; if(it.stock===0) it.available=false; render();
  }

  function deleteItem(){
    if(!editingId) return; state.menu = state.menu.filter(m=>m.id!==editingId); render(); closeDrawerFn();
  }

  // Floor map rendering
  function renderFloor(){
    floorMap.innerHTML='';
    state.tables.forEach(t=>{
      const el = document.createElement('div'); el.className='table-card';
      el.dataset.id=t.id; el.draggable=true;
      el.innerHTML = `<div class=num>Table ${t.num}</div><div class=text-xs mt-1>${t.guests} pax</div>`;
      if(t.status==='vacant') el.classList.add('pulse-vacant');
      if(t.status==='occupied') el.classList.add('pulse-occupied');
      if(t.status==='reserved') el.classList.add('pulse-reserved');

      // click to toggle status for demo
      el.addEventListener('click', ()=>{
        if(t.status==='vacant'){ occupyTable(t.id); }
        else if(t.status==='occupied'){ t.status='vacant'; t.occupiedSince=null; }
        else if(t.status==='reserved'){ t.status='occupied'; t.occupiedSince=Date.now(); }
        render();
      });

      // drag events
      el.addEventListener('dragstart', ev=>{ev.dataTransfer.setData('text/plain',t.id)});

      floorMap.appendChild(el);
    });

    // floor map drop area
    floorMap.addEventListener('dragover', e=>e.preventDefault());
    floorMap.addEventListener('drop', e=>{
      e.preventDefault(); const id = parseInt(e.dataTransfer.getData('text/plain')); const t = state.tables.find(x=>x.id===id); if(!t) return;
      // visual ripple
      const ripple = document.createElement('div'); ripple.style.position='absolute'; ripple.style.left = (e.offsetX-40)+'px'; ripple.style.top=(e.offsetY-40)+'px'; ripple.style.width='80px'; ripple.style.height='80px'; ripple.style.borderRadius='50%'; ripple.style.background='rgba(0,240,255,0.06)'; ripple.style.zIndex='50'; floorMap.appendChild(ripple);
      setTimeout(()=>ripple.remove(),600);
      render();
    });
  }

  function occupyTable(id){
    const t = state.tables.find(x=>x.id===id); if(!t) return; t.status='occupied'; t.occupiedSince = Date.now(); t.guests = Math.max(1,t.guests); t.total = 0; // new order
    // particle burst (simple animation)
    const burst = document.createElement('div'); burst.className='glass-pill'; burst.style.position='absolute'; burst.style.left='50%'; burst.style.top='10px'; burst.textContent='Occupied'; document.body.appendChild(burst);
    anime({targets:burst,translateY:[-20,0],opacity:[0,1],duration:700,easing:'easeOutCubic',complete:()=>{setTimeout(()=>anime({targets:burst,opacity:0,duration:400,complete:()=>burst.remove()}),600)}});
  }

  function updateInsights(){
    salesTodayEl.textContent = '$'+(state.salesToday||0).toFixed(2);
    activeOrdersEl.textContent = (state.activeOrders||0);
  }

  // Floating notification utility
  function showNotification({title, body, timeout = 3500} = {}){
    const n = document.createElement('div'); n.className='floating-notification';
    n.innerHTML = `<div class="title">${title}</div><div class="body text-sm text-gray-300">${body||''}</div>`;
    document.body.appendChild(n);
    anime({targets:n,opacity:[0,1],translateX:[20,0],duration:400,easing:'easeOutCubic'});
    setTimeout(()=>{ anime({targets:n,opacity:0,translateX:20,duration:300,easing:'easeInCubic',complete:()=>n.remove()}) }, timeout);
  }

  function updatePresence(list){
    if(!presenceList) return;
    presenceList.innerHTML='';
    list.slice(0,6).forEach(p => {
      const el = document.createElement('div'); el.className='presence-pill'; el.textContent = p.name || ('User '+p.userId);
      presenceList.appendChild(el);
    });
  }

  // Init Socket.IO client for real-time updates
  function initSocket(){
    if(typeof io === 'undefined'){
      console.warn('Socket.IO client not available');
      return;
    }
    const socket = io();
    socket.on('connect', ()=>{
      console.log('Socket connected', socket.id);
      // register as demo operator
      socket.emit('agent:register', { userId: 'ops_demo', name: 'Ops (Dashboard)', role: 'agent' });
    });

    socket.on('presenceUpdate', (list)=>{
      updatePresence(list);
    });

    socket.on('newMessage', (payload)=>{
      showNotification({title:'New Message', body:payload.message||'Message received'});
      // demo: increment active orders to show live activity
      state.activeOrders = (state.activeOrders||0) + 1;
      render();
    });

    socket.on('ticketCreated', (ticket)=>{
      showNotification({title:'Ticket Created', body:`#${ticket.id} ${ticket.subject||''}`});
    });

    socket.on('escalationRaised', (data)=>{
      showNotification({title:'Escalation', body:`Conversation ${data.conversationId} escalated`});
      // demo: mark a random vacant table as occupied to draw attention
      const vacant = state.tables.find(t=>t.status==='vacant'); if(vacant){ vacant.status='occupied'; vacant.occupiedSince=Date.now(); render(); }
    });

    socket.on('escalationAssigned', (data)=>{
      showNotification({title:'Escalation Assigned', body:`Assigned to ${data.assignedStaffId||'staff'}` });
    });

    socket.on('handoffAlert', (d)=>{
      showNotification({title:'Handoff Alert', body:`Handoff: ${d.conversationId||''}`});
    });

    socket.on('disconnect', ()=>{ console.log('Socket disconnected'); });
  }

  // event bindings
  addItemBtn.addEventListener('click', ()=>openDrawer());
  closeDrawer.addEventListener('click', closeDrawerFn);
  itemForm.addEventListener('submit', saveForm);
  deleteItemBtn.addEventListener('click', deleteItem);
  categoryFilter.addEventListener('change', renderMenu);

  // init
  initParticles(); render();
  initSocket();

  // Profile population & dropdown
  (function initProfile(){
    try{
      const name = localStorage.getItem('profileName') || 'Ops';
      const avatar = localStorage.getItem('avatarUrl');
      if(profileNameEl) profileNameEl.textContent = name;
      if(avatarImgEl && avatar){ avatarImgEl.src = avatar; avatarImgEl.style.display = 'inline-block'; if(avatarLetterEl) avatarLetterEl.style.display = 'none'; }
      else if(avatarLetterEl) avatarLetterEl.textContent = (name||'O').charAt(0).toUpperCase();
    }catch(e){}

    if(profileBtn && profileDropdown){
      profileBtn.addEventListener('click', ()=>{
        const open = profileDropdown.style.display === 'block';
        profileDropdown.style.display = open ? 'none' : 'block';
        profileBtn.setAttribute('aria-expanded', String(!open));
      });
      document.addEventListener('click', (ev)=>{
        if(!profileBtn.contains(ev.target) && !profileDropdown.contains(ev.target)){
          profileDropdown.style.display = 'none';
          profileBtn.setAttribute('aria-expanded','false');
        }
      });
    }
  })();

})();
