// Pénzügyi Tervező és Kiadáskövető - Core Vanilla JavaScript Engine
// Full localStorage persistence, rollover handling, 15th payday cycle auto-calculation,
// pending surplus decision modal, manual override starting balance, category analytics, and AI receipt scanning

const STORAGE_KEY = 'penzugyi_tervezo_data_v1';

// Default configuration & clean white-label initial template
const DEFAULT_STATE = {
  profileSetupDone: false,
  cycleStartDay: 1, // 1 (hónap eleje) | 15 (hó közepe) | egyedi (1..31)
  guaranteedIncome: 0,
  monthlyWeeklyBudget: 0,
  fixedExpenses: [],
  goals: [],

  // Fizetési ciklus és hetek kezelése
  weekMode: 'auto', // 'auto' (dátum alapján) | 'manual'
  manualWeek: null, // 1..4 ha manual

  // 4 heti gördülő költőpénz és maradvány-kezelés
  weeks: {
    1: { rollover: 0, hasManualRollover: false, customBaseBudget: null, manualRemaining: null, transferredOut: 0, transferredToNextWeek: 0, expenses: [], surplusStatus: 'none' },
    2: { rollover: 0, hasManualRollover: false, customBaseBudget: null, manualRemaining: null, transferredOut: 0, transferredToNextWeek: 0, expenses: [], surplusStatus: 'none' },
    3: { rollover: 0, hasManualRollover: false, customBaseBudget: null, manualRemaining: null, transferredOut: 0, transferredToNextWeek: 0, expenses: [], surplusStatus: 'none' },
    4: { rollover: 0, hasManualRollover: false, customBaseBudget: null, manualRemaining: null, transferredOut: 0, transferredToNextWeek: 0, expenses: [], surplusStatus: 'none' },
  },

  // Fehér címkés 1-kattintásos gyorsgombok
  quickButtons: [
    { id: 'qb-1', type: 'expense', category: 'hasznos', amount: 3000, label: 'Bevásárlás', icon: '🛒' },
    { id: 'qb-2', type: 'expense', category: 'szórakozás', amount: 1500, label: 'Kávé / Snack', icon: '☕' },
    { id: 'qb-3', type: 'expense', category: 'hasznos', amount: 5000, label: 'Tankolás', icon: '⛽' },
    { id: 'qb-4', type: 'income', amount: 20000, label: 'Extra Bevétel', icon: '💰' },
  ],

  // Megtakarítási és bevételi tranzakciótörténet
  history: []
};

class BudgetApp {
  constructor() {
    this.confirmCallback = null;
    this.analyticsTimeframe = 'month'; // 'day' | 'month' | 'year' | 'all'
    this.currentScanData = null;
    this.activeDecisionWeek = null;
    this.editModalSelectedWeek = null;
    this.resetCycleSelectedWeek = null;
    this.viewWeek = null; // currently selected week in UI
    this.manualSettingsOpen = false;
    this.currentSettingsTab = 'budget';

    // Wizard temporary state
    this.stateWizard = {
      step: 1,
      cycleStartDay: 1,
      income: 0,
      fixed: [],
      goals: [],
      weeklyBudget: 0,
      startWeek: 1
    };

    this.state = this.loadState();
    this.currentTab = 'weekly';
    this.init();
  }

  loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);

        // Sanitize any previous personal mock data from early prototypes
        let goals = Array.isArray(parsed.goals) ? parsed.goals : [];
        if (goals.some(g => g.name === 'Jogsi' || g.name === 'Síelés' || g.name === 'PS5 / GTA 6')) {
          goals = [];
        }

        let fixedExpenses = Array.isArray(parsed.fixedExpenses) ? parsed.fixedExpenses : [];
        if (fixedExpenses.some(f => f.name === 'Pszichológus' || f.name === 'Kondi' || f.name === 'Tánc' || f.name === 'BKK')) {
          fixedExpenses = [];
        }

        let history = Array.isArray(parsed.history) ? parsed.history : [];
        if (history.some(h => (h.breakdown || '').includes('Jogsi') || (h.title || '').includes('Jogsi'))) {
          history = [];
        }

        // Quick buttons
        let quickButtons = Array.isArray(parsed.quickButtons) && parsed.quickButtons.length > 0
          ? parsed.quickButtons.map(btn => ({
              ...btn,
              category: btn.category || (btn.type === 'expense' ? 'szórakozás' : undefined)
            }))
          : JSON.parse(JSON.stringify(DEFAULT_STATE.quickButtons));

        if (quickButtons.some(b => (b.label || '').includes('Meki') || (b.label || '').includes('Autómosás') || (b.label || '').includes('Kozmetika'))) {
          quickButtons = JSON.parse(JSON.stringify(DEFAULT_STATE.quickButtons));
        }

        // Migrate weeks and ensure customBaseBudget, manualRemaining, and hasManualRollover are present
        const weeks = { ...DEFAULT_STATE.weeks };
        const parsedWeeks = parsed.weeks || {};

        for (let w = 1; w <= 4; w++) {
          const wData = parsedWeeks[w] || { rollover: 0, expenses: [] };
          weeks[w] = {
            rollover: typeof wData.rollover === 'number' ? wData.rollover : (parseInt(wData.rollover, 10) || 0),
            hasManualRollover: Boolean(wData.hasManualRollover),
            customBaseBudget: typeof wData.customBaseBudget === 'number' ? wData.customBaseBudget : null,
            manualRemaining: typeof wData.manualRemaining === 'number' ? wData.manualRemaining : null,
            surplusStatus: wData.surplusStatus || 'none', // 'none' | 'pending' | 'resolved' | 'archived'
            transferredOut: typeof wData.transferredOut === 'number' ? wData.transferredOut : 0,
            transferredToNextWeek: typeof wData.transferredToNextWeek === 'number' ? wData.transferredToNextWeek : 0,
            expenses: Array.isArray(wData.expenses)
              ? wData.expenses.map((exp, eIdx) => ({
                  id: exp.id || `exp-${w}-${Date.now()}-${eIdx}`,
                  amount: typeof exp.amount === 'number' ? exp.amount : (parseInt(exp.amount, 10) || 0),
                  note: exp.note || 'Kiadás',
                  category: exp.category || this.inferCategory(exp.note),
                  date: exp.date || new Date().toLocaleDateString('hu-HU'),
                }))
              : []
          };
        }

        const profileSetupDone = Boolean(parsed.profileSetupDone) || (goals.length > 0 && parsed.guaranteedIncome > 0);
        const cycleStartDay = Math.min(31, Math.max(1, parseInt(parsed.cycleStartDay, 10) || 1));

        return {
          ...DEFAULT_STATE,
          ...parsed,
          profileSetupDone,
          cycleStartDay,
          guaranteedIncome: typeof parsed.guaranteedIncome === 'number' ? parsed.guaranteedIncome : 0,
          monthlyWeeklyBudget: typeof parsed.monthlyWeeklyBudget === 'number' ? parsed.monthlyWeeklyBudget : 0,
          fixedExpenses,
          goals,
          weekMode: parsed.weekMode || 'auto',
          manualWeek: parsed.manualWeek || null,
          quickButtons,
          history,
          weeks
        };
      }
    } catch (e) {
      console.error('Failed to load local storage state:', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  // Automatic heuristic category inference for older unclassified expenses
  inferCategory(note = '') {
    const lower = String(note).toLowerCase();
    const entertainmentKeywords = ['meki', 'mcdonald', 'kávé', 'cafe', 'mozi', 'cinema', 'buli', 'sör', 'bor', 'pub', 'bár', 'snack', 'étterem', 'pizza', 'burger', 'ps5', 'játék', 'game', 'party', 'koncert'];
    for (const kw of entertainmentKeywords) {
      if (lower.includes(kw)) return 'szórakozás';
    }
    return 'hasznos';
  }

  saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error('Failed to save to local storage:', e);
    }
    this.render();
  }

  // HAVI FIZETÉSI CIKLUS ÉS AUTOMATIKUS HÉT-SZÁMÍTÁS
  // Alapértelmezett: 1. vagy 15. nap, vagy a felhasználó által beállított tetszőleges nap
  getCycleInfo(currentDate = new Date()) {
    const monthNamesShort = ['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];
    const d = currentDate.getDate();
    const m = currentDate.getMonth(); // 0..11
    const y = currentDate.getFullYear();
    const startDay = Math.min(28, Math.max(1, Number(this.state?.cycleStartDay) || 1));

    let cycleStartDate;
    let nextCycleStartDate;

    if (d >= startDay) {
      cycleStartDate = new Date(y, m, startDay);
      nextCycleStartDate = new Date(m === 11 ? y + 1 : y, (m + 1) % 12, startDay);
    } else {
      cycleStartDate = new Date(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, startDay);
      nextCycleStartDate = new Date(y, m, startDay);
    }

    const msPerDay = 86400000;
    const elapsedDays = Math.floor((currentDate.getTime() - cycleStartDate.getTime()) / msPerDay);

    let autoWeek = 1;
    if (elapsedDays < 7) {
      autoWeek = 1;
    } else if (elapsedDays < 14) {
      autoWeek = 2;
    } else if (elapsedDays < 21) {
      autoWeek = 3;
    } else {
      autoWeek = 4;
    }

    const formatDate = (date) => `${monthNamesShort[date.getMonth()]} ${date.getDate()}.`;
    
    // Week 1: cycleStartDate to cycleStartDate + 6 days
    const w1Start = new Date(cycleStartDate);
    const w1End = new Date(cycleStartDate); w1End.setDate(w1End.getDate() + 6);

    // Week 2: +7 to +13
    const w2Start = new Date(cycleStartDate); w2Start.setDate(w2Start.getDate() + 7);
    const w2End = new Date(cycleStartDate); w2End.setDate(w2End.getDate() + 13);

    // Week 3: +14 to +20
    const w3Start = new Date(cycleStartDate); w3Start.setDate(w3Start.getDate() + 14);
    const w3End = new Date(cycleStartDate); w3End.setDate(w3End.getDate() + 20);

    // Week 4: +21 to (nextCycleStartDate - 1 day)
    const w4Start = new Date(cycleStartDate); w4Start.setDate(w4Start.getDate() + 21);
    const w4End = new Date(nextCycleStartDate); w4End.setDate(w4End.getDate() - 1);

    const weekDateRanges = {
      1: `${formatDate(w1Start)} – ${formatDate(w1End)}`,
      2: `${formatDate(w2Start)} – ${formatDate(w2End)}`,
      3: `${formatDate(w3Start)} – ${formatDate(w3End)}`,
      4: `${formatDate(w4Start)} – ${formatDate(w4End)}`,
    };

    const cycleLabel = `${cycleStartDate.getFullYear()}. ${formatDate(cycleStartDate)} – ${w4End.getFullYear() !== cycleStartDate.getFullYear() ? w4End.getFullYear() + '. ' : ''}${formatDate(w4End)}`;

    return {
      autoWeek,
      weekDateRanges,
      cycleLabel,
      cycleStartYear: cycleStartDate.getFullYear(),
      cycleStartMonth: cycleStartDate.getMonth(),
      cycleEndYear: w4End.getFullYear(),
      cycleEndMonth: w4End.getMonth(),
      startDay,
      currentDay: d
    };
  }

  // Active week resolution (Auto vs Manual)
  getActiveWeek() {
    if (this.viewWeek !== null) {
      return this.viewWeek;
    }
    if (this.state.weekMode === 'manual' && this.state.manualWeek) {
      return this.state.manualWeek;
    }
    const cycle = this.getCycleInfo();
    return cycle.autoWeek;
  }

  setWeekMode(mode, manualWeekNum = null) {
    if (mode === 'auto') {
      this.state.weekMode = 'auto';
      this.state.manualWeek = null;
      this.viewWeek = null;
      const cycle = this.getCycleInfo();
      this.showToast(`Automatikus heti mód aktiválva (${cycle.autoWeek}. hét)`, '🔄');
    } else {
      this.state.weekMode = 'manual';
      this.state.manualWeek = manualWeekNum || 1;
      this.viewWeek = this.state.manualWeek;
      this.showToast(`Kézi heti mód beállítva: ${this.state.manualWeek}. hét`, '⚙️');
    }
    this.saveState();
  }

  selectWeek(weekNum) {
    this.viewWeek = weekNum;
    if (this.state.weekMode === 'manual') {
      this.state.manualWeek = weekNum;
    }
    this.saveState();
  }

  selectWeekManual(weekNum) {
    this.state.weekMode = 'manual';
    this.state.manualWeek = weekNum;
    this.viewWeek = weekNum;
    this.saveState();
    this.showToast(`Kézi hét kiválasztva: ${weekNum}. hét`, '📅');
  }

  toggleManualSettingsBox() {
    this.manualSettingsOpen = !this.manualSettingsOpen;
    const box = document.getElementById('manualSettingsBox');
    const arrow = document.getElementById('manualSettingsToggleArrow');
    if (box) {
      box.classList.toggle('hidden', !this.manualSettingsOpen);
    }
    if (arrow) {
      arrow.textContent = this.manualSettingsOpen ? '▲' : '▼';
    }
    if (this.manualSettingsOpen) {
      this.updateCustomBudgetInputDisplay();
    }
  }

  focusManualStartingBudget() {
    this.manualSettingsOpen = true;
    const box = document.getElementById('manualSettingsBox');
    const arrow = document.getElementById('manualSettingsToggleArrow');
    if (box) box.classList.remove('hidden');
    if (arrow) arrow.textContent = '▲';
    this.updateCustomBudgetInputDisplay();
    const input = document.getElementById('customWeekBudgetInput');
    if (input) {
      input.focus();
      input.select();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  setQuickCustomBudget(amount) {
    const curWeek = this.getActiveWeek();
    const wData = this.getWeekData(curWeek);
    wData.customBaseBudget = amount;

    const input = document.getElementById('customWeekBudgetInput');
    if (input) input.value = amount;

    this.updateRolloversChain();
    this.saveState();
    this.showToast(`A(z) ${curWeek}. hét induló kerete mentve: ${this.formatFt(amount)}`, '✅');
  }

  updateCustomBudgetInputDisplay() {
    const curWeek = this.getActiveWeek();
    const wData = this.getWeekData(curWeek);
    const input = document.getElementById('customWeekBudgetInput');
    if (input) {
      input.value = wData.customBaseBudget !== null ? wData.customBaseBudget : this.getWeeklyBaseBudget();
    }
    const label = document.getElementById('customWeekBudgetLabel');
    if (label) {
      label.textContent = `A(z) ${curWeek}. hét induló kerete:`;
    }
  }

  saveCustomWeekBudget() {
    const curWeek = this.getActiveWeek();
    const input = document.getElementById('customWeekBudgetInput');
    const val = parseInt(input?.value, 10);

    if (isNaN(val) || val < 0) {
      alert('Kérlek adj meg érvényes forint összeget!');
      return;
    }

    const wData = this.getWeekData(curWeek);
    wData.customBaseBudget = val;

    this.updateRolloversChain();
    this.saveState();
    this.showToast(`A(z) ${curWeek}. hét induló kerete mentve: ${this.formatFt(val)}`, '✅');
  }

  resetCustomWeekBudget() {
    const curWeek = this.getActiveWeek();
    const wData = this.getWeekData(curWeek);
    wData.customBaseBudget = null;

    this.updateRolloversChain();
    this.saveState();
    const standard = this.getWeeklyBaseBudget();
    this.showToast(`A(z) ${curWeek}. hét induló kerete visszaállítva az alap ${this.formatFt(standard)} összegre`, '↺');
  }

  // In-app confirmation dialog
  askConfirm(title, message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMessage');
    const actionBtn = document.getElementById('confirmModalActionBtn');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');

    if (!modal) {
      if (window.confirm(`${title}\n\n${message}`)) {
        onConfirm();
      }
      return;
    }

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;

    this.confirmCallback = onConfirm;

    const close = () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      this.confirmCallback = null;
    };

    actionBtn.onclick = () => {
      if (typeof this.confirmCallback === 'function') {
        this.confirmCallback();
      }
      close();
    };

    cancelBtn.onclick = close;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  resetDemo() {
    this.askConfirm(
      'Alaphelyzet visszaállítása',
      'Biztosan visszaállítod az összes alapértelmezett adatot? Minden egyéni módosítás felülíródik.',
      () => {
        this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
        this.viewWeek = null;
        this.saveState();
        this.showToast('Alapértelmezett adatok sikeresen visszaállítva!', '🔄');
      }
    );
  }

  init() {
    // PWA Service Worker registration
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }

    // Event listeners
    document.getElementById('openSettingsBtn')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('exportImportBtn')?.addEventListener('click', () => this.openBackupModal());

    const distInput = document.getElementById('distributeAmount');
    if (distInput) {
      distInput.addEventListener('input', () => this.updateDistributePreview());
    }

    const customInput = document.getElementById('customWeekBudgetInput');
    if (customInput) {
      customInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.saveCustomWeekBudget();
        }
      });
    }

    // Auto-check for closed weeks with pending surpluses
    this.checkAndFlagClosedWeeksSurplus();
    this.updateRolloversChain();

    this.render();
    this.updateDistributePreview();

    // Trigger Onboarding Wizard if no profile is saved yet
    if (!this.state.profileSetupDone) {
      setTimeout(() => {
        this.openOnboardingWizard();
      }, 150);
    } else {
      // If there is an ended week with pending surplus, auto-prompt decision modal once
      const pendingWeek = this.getFirstPendingSurplusWeek();
      if (pendingWeek && !this.sessionPrompted) {
        this.sessionPrompted = true;
        setTimeout(() => {
          this.openWeekDecisionModal(pendingWeek);
        }, 500);
      }
    }
  }

  formatFt(amount) {
    const val = Math.round(Number(amount) || 0);
    return val.toLocaleString('hu-HU') + ' Ft';
  }

  showToast(message, icon = '✨') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMessage');
    const toastIco = document.getElementById('toastIcon');
    if (!toast || !toastMsg) return;

    toastMsg.textContent = message;
    if (toastIco) toastIco.textContent = icon;

    toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-3');
    toast.classList.add('opacity-100', 'translate-y-0');

    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-3');
    }, 3200);
  }

  switchTab(tabId) {
    this.currentTab = tabId;
    ['weekly', 'goals', 'fixed', 'analytics'].forEach(t => {
      const panel = document.getElementById(`panel-${t}`);
      const tabBtn = document.getElementById(`tab-${t}`);
      if (panel) {
        if (t === tabId) {
          panel.classList.remove('hidden');
        } else {
          panel.classList.add('hidden');
        }
      }
      if (tabBtn) {
        if (t === tabId) {
          tabBtn.className = 'py-2.5 px-2 rounded-xl font-bold text-xs flex flex-col sm:flex-row items-center justify-center gap-1 transition duration-150 bg-emerald-500 text-slate-950 shadow-md';
        } else {
          tabBtn.className = 'py-2.5 px-2 rounded-xl font-bold text-xs flex flex-col sm:flex-row items-center justify-center gap-1 transition duration-150 text-slate-400 hover:text-slate-200';
        }
      }
    });

    if (tabId === 'analytics') {
      this.renderAnalyticsSection();
    }
  }

  // ==========================================
  // SECTION 5: EDITABLE QUICK BUTTONS
  // ==========================================
  renderQuickButtons() {
    const container = document.getElementById('quickButtonsContainer');
    if (!container) return;

    const buttons = this.state.quickButtons || [];

    if (buttons.length === 0) {
      container.innerHTML = `
        <div class="col-span-full p-4 text-center text-xs text-slate-500 bg-slate-950/40 rounded-xl border border-slate-800">
          Nincsenek gyorsgombok. Kattints a "Gombok szerkesztése" gombra!
        </div>
      `;
      return;
    }

    container.innerHTML = buttons.map(btn => {
      const isExpense = btn.type === 'expense';
      const category = btn.category || 'hasznos';
      const isFun = category === 'szórakozás';

      if (isExpense) {
        return `
          <button onclick="app.quickExpense(${btn.amount}, '${this.escapeHtml(btn.label)}', '${category}')" class="flex flex-col items-start p-2.5 rounded-xl ${isFun ? 'bg-purple-950/25 hover:bg-purple-950/40 border-purple-800/40 hover:border-purple-600/60' : 'bg-rose-950/20 hover:bg-rose-950/40 border-rose-800/30 hover:border-rose-700/60'} border active:scale-[0.98] transition group text-left">
            <div class="flex items-center justify-between w-full">
              <span class="text-[9px] ${isFun ? 'text-purple-300' : 'text-rose-300'} font-semibold uppercase tracking-wider">Kiadás</span>
              <span class="text-[9px] ${isFun ? 'text-purple-400' : 'text-emerald-400'} font-bold">${isFun ? '🎭 Szórakozás' : '🛒 Hasznos'}</span>
            </div>
            <span class="text-sm font-extrabold ${isFun ? 'text-purple-400 group-hover:text-purple-300' : 'text-rose-400 group-hover:text-rose-300'}">- ${this.formatFt(btn.amount)}</span>
            <span class="text-xs text-slate-300 truncate w-full mt-0.5">${btn.icon || '💸'} ${this.escapeHtml(btn.label)}</span>
          </button>
        `;
      } else {
        return `
          <button onclick="app.openDistributeModal(${btn.amount}, '${this.escapeHtml(btn.label)}')" class="flex flex-col items-start p-2.5 rounded-xl bg-emerald-950/20 hover:bg-emerald-950/40 border border-emerald-800/30 hover:border-emerald-700/60 active:scale-[0.98] transition group text-left">
            <span class="text-[10px] text-emerald-300 font-semibold uppercase tracking-wider">Bevétel & Célok</span>
            <span class="text-sm font-extrabold text-emerald-400 group-hover:text-emerald-300">+ ${this.formatFt(btn.amount)}</span>
            <span class="text-xs text-slate-300 truncate w-full mt-0.5">${btn.icon || '💰'} ${this.escapeHtml(btn.label)}</span>
          </button>
        `;
      }
    }).join('');
  }

  toggleQbCategoryVisibility() {
    const type = document.getElementById('qbType')?.value;
    const catWrapper = document.getElementById('qbCategoryWrapper');
    if (catWrapper) {
      if (type === 'income') {
        catWrapper.classList.add('hidden');
      } else {
        catWrapper.classList.remove('hidden');
      }
    }
  }

  openManageQuickButtonsModal() {
    this.resetQuickButtonForm();
    this.renderManageQuickButtonsList();
    const modal = document.getElementById('quickButtonsModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  closeManageQuickButtonsModal() {
    const modal = document.getElementById('quickButtonsModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  renderManageQuickButtonsList() {
    const list = document.getElementById('manageQuickButtonsList');
    if (!list) return;

    const buttons = this.state.quickButtons || [];
    if (buttons.length === 0) {
      list.innerHTML = `<div class="p-3 text-center text-xs text-slate-500 bg-slate-950/60 rounded-xl border border-slate-800">Nincsenek gyorsgombok. Adj hozzá egyet a fenti űrlappal!</div>`;
      return;
    }

    list.innerHTML = buttons.map(btn => {
      const isExpense = btn.type === 'expense';
      const category = btn.category || 'hasznos';
      return `
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition">
          <div class="flex items-center gap-2.5">
            <span class="text-base">${btn.icon || '⚡'}</span>
            <div>
              <div class="flex items-center gap-2">
                <span class="text-xs font-bold text-white">${this.escapeHtml(btn.label)}</span>
                <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold uppercase ${isExpense ? (category === 'szórakozás' ? 'bg-purple-950/60 text-purple-300 border border-purple-800/40' : 'bg-rose-950/60 text-rose-300 border border-rose-800/40') : 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/40'}">
                  ${isExpense ? (category === 'szórakozás' ? '🎭 Szórakozás' : '🛒 Hasznos') : 'Bevétel'}
                </span>
              </div>
              <span class="text-xs font-extrabold ${isExpense ? 'text-rose-400' : 'text-emerald-400'}">
                ${isExpense ? '-' : '+'}${this.formatFt(btn.amount)}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <button onclick="app.editQuickButton('${btn.id}')" title="Szerkesztés" class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
            </button>
            <button onclick="app.deleteQuickButton('${btn.id}')" title="Törlés" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  resetQuickButtonForm() {
    const qbId = document.getElementById('qbId');
    const qbType = document.getElementById('qbType');
    const qbCategory = document.getElementById('qbCategory');
    const qbAmount = document.getElementById('qbAmount');
    const qbLabel = document.getElementById('qbLabel');
    const qbIcon = document.getElementById('qbIcon');
    const formTitle = document.getElementById('quickButtonFormTitle');
    const submitBtn = document.getElementById('qbSubmitBtn');
    const cancelBtn = document.getElementById('cancelEditQuickBtn');

    if (qbId) qbId.value = '';
    if (qbType) qbType.value = 'expense';
    if (qbCategory) qbCategory.value = 'szórakozás';
    if (qbAmount) qbAmount.value = '';
    if (qbLabel) qbLabel.value = '';
    if (qbIcon) qbIcon.value = '⚡';
    if (formTitle) formTitle.textContent = '+ Új gyorsgomb létrehozása';
    if (submitBtn) submitBtn.textContent = 'Gomb mentése';
    if (cancelBtn) cancelBtn.classList.add('hidden');
    this.toggleQbCategoryVisibility();
  }

  editQuickButton(id) {
    const btn = (this.state.quickButtons || []).find(b => b.id === id);
    if (!btn) return;

    document.getElementById('qbId').value = btn.id;
    document.getElementById('qbType').value = btn.type;
    const catInput = document.getElementById('qbCategory');
    if (catInput) catInput.value = btn.category || 'szórakozás';
    document.getElementById('qbAmount').value = btn.amount;
    document.getElementById('qbLabel').value = btn.label;
    document.getElementById('qbIcon').value = btn.icon || '⚡';
    document.getElementById('quickButtonFormTitle').textContent = '✏️ Gyorsgomb módosítása';
    document.getElementById('qbSubmitBtn').textContent = 'Módosítás mentése';
    document.getElementById('cancelEditQuickBtn')?.classList.remove('hidden');
    this.toggleQbCategoryVisibility();
    document.getElementById('qbLabel').focus();
  }

  handleSaveQuickButton(e) {
    e.preventDefault();
    const id = document.getElementById('qbId').value;
    const type = document.getElementById('qbType').value;
    const category = type === 'expense' ? (document.getElementById('qbCategory')?.value || 'hasznos') : undefined;
    const amount = parseInt(document.getElementById('qbAmount').value, 10);
    const label = document.getElementById('qbLabel').value.trim();
    const icon = document.getElementById('qbIcon').value.trim() || '⚡';

    if (!label || isNaN(amount) || amount <= 0) {
      alert('Kérlek adj meg érvényes megnevezést és pozitív összeget!');
      return;
    }

    if (!Array.isArray(this.state.quickButtons)) {
      this.state.quickButtons = [];
    }

    if (id) {
      const idx = this.state.quickButtons.findIndex(b => b.id === id);
      if (idx !== -1) {
        this.state.quickButtons[idx] = { id, type, category, amount, label, icon };
        this.showToast(`Gyorsgomb frissítve: ${label}`, '✏️');
      }
    } else {
      this.state.quickButtons.push({
        id: 'qb-' + Date.now(),
        type,
        category,
        amount,
        label,
        icon
      });
      this.showToast(`Új gyorsgomb hozzáadva: ${label}`, '✅');
    }

    this.resetQuickButtonForm();
    this.saveState();
    this.renderManageQuickButtonsList();
  }

  deleteQuickButton(id) {
    const btn = (this.state.quickButtons || []).find(b => b.id === id);
    if (!btn) return;

    this.askConfirm(
      'Gyorsgomb törlése',
      `Biztosan törölni szeretnéd a(z) "${btn.label}" gyorsgombot?`,
      () => {
        this.state.quickButtons = this.state.quickButtons.filter(b => b.id !== id);
        this.saveState();
        this.renderManageQuickButtonsList();
        this.showToast(`Gyorsgomb törölve: ${btn.label}`, '🗑️');
      }
    );
  }

  resetDefaultQuickButtons() {
    this.askConfirm(
      'Alapértelmezett gombok',
      'Visszaállítod az alapértelmezett gyorsgombokat?',
      () => {
        this.state.quickButtons = JSON.parse(JSON.stringify(DEFAULT_STATE.quickButtons));
        this.resetQuickButtonForm();
        this.saveState();
        this.renderManageQuickButtonsList();
        this.showToast('Alapértelmezett gyorsgombok visszaállítva!', '🔄');
      }
    );
  }

  // ==========================================
  // SECTION 1: FIXED EXPENSES & BASE INCOME
  // ==========================================
  getTotalFixedExpenses() {
    return this.state.fixedExpenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  }

  getBaseFreeBudget() {
    const income = Number(this.state.guaranteedIncome) || 0;
    const fixed = this.getTotalFixedExpenses();
    return Math.max(0, income - fixed);
  }

  updateGuaranteedIncome(val) {
    const num = Math.max(0, parseInt(val, 10) || 0);
    this.state.guaranteedIncome = num;
    this.saveState();
    this.showToast('Garantált havi bevétel frissítve!', '💰');
  }

  updateMonthlyWeeklyBudget(val) {
    const num = Math.max(0, parseInt(val, 10) || 0);
    this.state.monthlyWeeklyBudget = num;
    this.saveState();
    this.showToast('Heti költőpénz havi alapkerete frissítve!', '⚙️');
  }

  syncBudgetWithFreeKeret() {
    const free = this.getBaseFreeBudget();
    this.state.monthlyWeeklyBudget = free;
    const input = document.getElementById('monthlyWeeklyBudgetInput');
    if (input) input.value = free;
    this.saveState();
    this.showToast(`Keret szinkronizálva az Alap Szabad Kerettel: ${this.formatFt(free)}`, '🔗');
  }

  toggleAddFixedForm() {
    const form = document.getElementById('addFixedFormContainer');
    if (form) {
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) {
        document.getElementById('newFixedName')?.focus();
      }
    }
  }

  handleAddFixedExpense(e) {
    e.preventDefault();
    const nameInput = document.getElementById('newFixedName');
    const amountInput = document.getElementById('newFixedAmount');
    const name = nameInput.value.trim();
    const amount = parseInt(amountInput.value, 10);

    if (!name || isNaN(amount) || amount <= 0) return;

    this.state.fixedExpenses.push({
      id: 'fix-' + Date.now(),
      name,
      amount
    });

    nameInput.value = '';
    amountInput.value = '';
    this.toggleAddFixedForm();
    this.saveState();
    this.showToast(`Új fix kiadás hozzáadva: ${name} (${this.formatFt(amount)})`, '✅');
  }

  deleteFixedExpense(id) {
    const item = this.state.fixedExpenses.find(x => x.id === id);
    if (!item) return;

    this.askConfirm(
      'Fix kiadás törlése',
      `Biztosan törölni szeretnéd ezt a fix kiadást: "${item.name}" (${this.formatFt(item.amount)})?`,
      () => {
        this.state.fixedExpenses = this.state.fixedExpenses.filter(x => x.id !== id);
        this.saveState();
        this.showToast(`Fix kiadás törölve: ${item.name}`, '🗑️');
      }
    );
  }

  // ==========================================
  // SECTION 2 & 3: GOALS & AUTO-SPLITTER
  // ==========================================
  getTotalGoalsPercentage() {
    return this.state.goals.reduce((sum, g) => sum + (Number(g.percent) || 0), 0);
  }

  openAddGoalModal() {
    document.getElementById('goalModalTitle').textContent = 'Új Megtakarítási Cél';
    document.getElementById('goalModalId').value = '';
    document.getElementById('goalModalName').value = '';
    document.getElementById('goalModalTarget').value = '200000';
    document.getElementById('goalModalCurrent').value = '0';

    const currentTotal = this.getTotalGoalsPercentage();
    const suggested = Math.max(0, 100 - currentTotal);
    document.getElementById('goalModalPercent').value = suggested;
    document.getElementById('goalModalPercentRange').value = suggested;

    const modal = document.getElementById('goalModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('goalModalName').focus();
  }

  openEditGoalModal(id) {
    const goal = this.state.goals.find(g => g.id === id);
    if (!goal) return;

    document.getElementById('goalModalTitle').textContent = 'Megtakarítási Cél Módosítása';
    document.getElementById('goalModalId').value = goal.id;
    document.getElementById('goalModalName').value = goal.name;
    document.getElementById('goalModalTarget').value = goal.target;
    document.getElementById('goalModalCurrent').value = goal.current;
    document.getElementById('goalModalPercent').value = goal.percent;
    document.getElementById('goalModalPercentRange').value = goal.percent;

    const modal = document.getElementById('goalModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  closeGoalModal() {
    const modal = document.getElementById('goalModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  handleSaveGoal(e) {
    e.preventDefault();
    const id = document.getElementById('goalModalId').value;
    const name = document.getElementById('goalModalName').value.trim();
    const target = parseInt(document.getElementById('goalModalTarget').value, 10);
    const current = parseInt(document.getElementById('goalModalCurrent').value, 10) || 0;
    const percent = parseInt(document.getElementById('goalModalPercent').value, 10) || 0;

    if (!name || isNaN(target) || target <= 0) {
      alert('Kérlek adj meg érvényes nevet és célösszeget!');
      return;
    }

    if (id) {
      const index = this.state.goals.findIndex(g => g.id === id);
      if (index !== -1) {
        this.state.goals[index] = { ...this.state.goals[index], name, target, current, percent };
        this.showToast(`Cél módosítva: ${name}`, '✏️');
      }
    } else {
      this.state.goals.push({
        id: 'goal-' + Date.now(),
        name,
        target,
        current,
        percent
      });
      this.showToast(`Új cél létrehozva: ${name}`, '🎯');
    }

    this.closeGoalModal();
    this.saveState();
    this.updateDistributePreview();
  }

  deleteGoal(id) {
    const goal = this.state.goals.find(g => g.id === id);
    if (!goal) return;

    this.askConfirm(
      'Megtakarítási cél törlése',
      `Biztosan törölni szeretnéd a(z) "${goal.name}" célt? A benne lévő eddigi megtakarítási összeg (${this.formatFt(goal.current)}) is törlődik.`,
      () => {
        this.state.goals = this.state.goals.filter(g => g.id !== id);
        this.saveState();
        this.showToast(`Cél törölve: ${goal.name}`, '🗑️');
        this.updateDistributePreview();
      }
    );
  }

  adjustGoalFunds(id, delta) {
    const goal = this.state.goals.find(g => g.id === id);
    if (!goal) return;
    const promptText = delta > 0 
      ? `Mennyi pénzt szeretnél hozzáadni a(z) "${goal.name}" célhoz? (Ft)`
      : `Mennyi pénzt szeretnél kivenni a(z) "${goal.name}" célból? (Ft)`;
    const input = prompt(promptText, '5000');
    if (!input) return;
    const amount = parseInt(input, 10);
    if (isNaN(amount) || amount <= 0) return;

    if (delta < 0 && goal.current < amount) {
      alert(`Nincs ennyi megtakarítás ebben a célban! Jelenleg: ${this.formatFt(goal.current)}`);
      return;
    }

    goal.current = Math.max(0, goal.current + (delta > 0 ? amount : -amount));
    
    // Add to history
    this.state.history.unshift({
      id: 'tx-' + Date.now(),
      date: new Date().toLocaleDateString('hu-HU'),
      title: delta > 0 ? `Kézi jóváírás: ${goal.name}` : `Kézi pénzkivét: ${goal.name}`,
      amount: delta > 0 ? amount : -amount,
      breakdown: `${goal.name}: ${this.formatFt(goal.current)}`
    });

    this.saveState();
    this.showToast(delta > 0 ? `+${this.formatFt(amount)} hozzáadva: ${goal.name}` : `-${this.formatFt(amount)} levonva: ${goal.name}`, '💰');
  }

  updateDistributePreview() {
    const container = document.getElementById('distributionPreview');
    if (!container) return;

    const amountInput = document.getElementById('distributeAmount');
    const amount = parseInt(amountInput?.value, 10) || 0;
    const totalPercent = this.getTotalGoalsPercentage();

    if (this.state.goals.length === 0) {
      container.innerHTML = '<span class="text-rose-400">Nincs rögzítve megtakarítási cél. Hozz létre egyet feljebb!</span>';
      return;
    }

    let html = `<div class="flex items-center justify-between font-bold mb-1.5 pb-1 border-b border-slate-800 text-[11px]">
      <span class="text-slate-400">Szétosztási előnézet (${this.formatFt(amount)}):</span>
      <span class="${totalPercent === 100 ? 'text-emerald-400' : 'text-rose-400'}">Arányok összege: ${totalPercent}%</span>
    </div><div class="grid grid-cols-1 sm:grid-cols-3 gap-2">`;

    this.state.goals.forEach(g => {
      const share = Math.round((amount * (g.percent || 0)) / 100);
      html += `<div class="bg-slate-900/80 p-1.5 rounded-lg border border-slate-800/80 flex items-center justify-between">
        <span class="truncate text-slate-300 font-medium">${this.escapeHtml(g.name)} (${g.percent}%):</span>
        <span class="text-emerald-400 font-bold ml-1">${this.formatFt(share)}</span>
      </div>`;
    });

    html += `</div>`;
    container.innerHTML = html;
  }

  handleDistributeIncome(e) {
    e.preventDefault();
    const amountInput = document.getElementById('distributeAmount');
    const noteInput = document.getElementById('distributeNote');
    const amount = parseInt(amountInput.value, 10);
    const note = noteInput.value.trim() || 'Változó bevétel';

    if (isNaN(amount) || amount <= 0) {
      alert('Kérlek adj meg pozitív összeget!');
      return;
    }

    if (this.state.goals.length === 0) {
      alert('Nincs még egyetlen megtakarítási célod sem! Hozz létre legalább egy célt a szétosztáshoz.');
      return;
    }

    const totalPercent = this.getTotalGoalsPercentage();
    if (totalPercent !== 100) {
      this.askConfirm(
        'Százalékos arány nem 100%',
        `A célok százalékos arányának összege jelenleg ${totalPercent}%, nem 100%. Szeretnéd arányosan szétosztani az összeget így is?`,
        () => this.executeDistribution(amount, note, totalPercent)
      );
      return;
    }

    this.executeDistribution(amount, note, totalPercent);
  }

  executeDistribution(amount, note, totalPercent) {
    const amountInput = document.getElementById('distributeAmount');
    const breakdownParts = [];
    let distributedSum = 0;

    this.state.goals.forEach((goal, index) => {
      let share = 0;
      if (totalPercent > 0) {
        if (index === this.state.goals.length - 1 && totalPercent === 100) {
          share = amount - distributedSum;
        } else {
          share = Math.round((amount * goal.percent) / totalPercent);
          distributedSum += share;
        }
      }
      goal.current = (goal.current || 0) + share;
      breakdownParts.push(`${goal.name}: +${this.formatFt(share)}`);
    });

    this.state.history.unshift({
      id: 'tx-' + Date.now(),
      date: new Date().toLocaleDateString('hu-HU') + ' ' + new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }),
      title: `⚡ ${note}`,
      amount: amount,
      breakdown: breakdownParts.join(' | ')
    });

    if (amountInput) amountInput.value = '';
    this.saveState();
    this.showToast(`+${this.formatFt(amount)} szétosztva a célok között!`, '🎉');
  }

  openDistributeModal(amount, note) {
    this.switchTab('goals');
    const amountInput = document.getElementById('distributeAmount');
    const noteInput = document.getElementById('distributeNote');
    if (amountInput) amountInput.value = amount;
    if (noteInput) noteInput.value = note;
    this.updateDistributePreview();
    amountInput?.focus();
    this.showToast(`Bevétel előkészítve: ${note} (${this.formatFt(amount)})`, '⚡');
  }

  // ==========================================
  // SAVINGS HISTORY: EDIT, DELETE, CLEAR ALL
  // ==========================================
  openClearHistoryConfirm() {
    this.askConfirm(
      'Teljes történet törlése',
      'Biztosan törölni szeretnéd az összes eddigi bevételi és megtakarítási tranzakciót a történetből? A jelenlegi megtakarítási cél egyenlegek nem változnak.',
      () => {
        this.state.history = [];
        this.saveState();
        this.showToast('A tranzakciótörténet sikeresen törölve!', '🗑️');
      }
    );
  }

  deleteHistoryItem(id) {
    const item = (this.state.history || []).find(h => h.id === id);
    if (!item) return;

    this.askConfirm(
      'Tranzakció törlése',
      `Biztosan törölni szeretnéd a(z) "${item.title}" tranzakciót a történetből?`,
      () => {
        this.state.history = this.state.history.filter(h => h.id !== id);
        this.saveState();
        this.showToast('Tranzakció törölve a történetből!', '🗑️');
      }
    );
  }

  openEditHistoryModal(id) {
    const item = (this.state.history || []).find(h => h.id === id);
    if (!item) return;

    document.getElementById('editHistoryId').value = item.id;
    document.getElementById('editHistoryTitle').value = item.title;
    document.getElementById('editHistoryAmount').value = item.amount;
    document.getElementById('editHistoryDate').value = item.date;
    document.getElementById('editHistoryBreakdown').value = item.breakdown || '';

    const modal = document.getElementById('editHistoryModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('editHistoryTitle').focus();
  }

  closeEditHistoryModal() {
    const modal = document.getElementById('editHistoryModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  handleSaveHistoryItem(e) {
    e.preventDefault();
    const id = document.getElementById('editHistoryId').value;
    const title = document.getElementById('editHistoryTitle').value.trim();
    const amount = parseInt(document.getElementById('editHistoryAmount').value, 10);
    const date = document.getElementById('editHistoryDate').value.trim();
    const breakdown = document.getElementById('editHistoryBreakdown').value.trim();

    if (!title || isNaN(amount) || !date) {
      alert('Kérlek tölts ki minden kötelező mezőt!');
      return;
    }

    const idx = (this.state.history || []).findIndex(h => h.id === id);
    if (idx !== -1) {
      this.state.history[idx] = {
        ...this.state.history[idx],
        title,
        amount,
        date,
        breakdown
      };
      this.closeEditHistoryModal();
      this.saveState();
      this.showToast('Tranzakció sikeresen módosítva!', '✏️');
    }
  }

  // ==========================================
  // SECTION 4: WEEKLY SPENDING & ROLLOVER LOGIC
  // ==========================================
  getWeeklyBaseBudget() {
    const monthly = Number(this.state.monthlyWeeklyBudget) || 60000;
    return Math.round(monthly / 4);
  }

  getBaseBudgetForWeek(weekNum) {
    const wData = this.getWeekData(weekNum);
    if (wData.customBaseBudget !== null && wData.customBaseBudget !== undefined) {
      return Number(wData.customBaseBudget);
    }
    return this.getWeeklyBaseBudget();
  }

  getWeekData(weekNum) {
    if (!this.state.weeks[weekNum]) {
      this.state.weeks[weekNum] = { rollover: 0, customBaseBudget: null, expenses: [], surplusStatus: 'none' };
    }
    return this.state.weeks[weekNum];
  }

  getEffectiveWeeklyBudget(weekNum) {
    const base = this.getBaseBudgetForWeek(weekNum);
    const week = this.getWeekData(weekNum);
    return base + (Number(week.rollover) || 0);
  }

  getWeeklySpent(weekNum) {
    const week = this.getWeekData(weekNum);
    return (week.expenses || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  }

  getWeeklyRemaining(weekNum) {
    const wData = this.getWeekData(weekNum);
    // Ha a felhasználó közvetlenül megadta a hátralévő keretet (pl. pontosan 8 500 Ft)
    if (wData.manualRemaining !== null && wData.manualRemaining !== undefined) {
      return Number(wData.manualRemaining);
    }
    const effective = this.getEffectiveWeeklyBudget(weekNum);
    const spent = this.getWeeklySpent(weekNum);
    const transferred = Number(wData.transferredOut) || 0;
    return effective - spent - transferred;
  }

  // Check if past weeks have positive surplus that was NOT yet resolved
  checkAndFlagClosedWeeksSurplus() {
    const cycle = this.getCycleInfo();
    const isManual = this.state.weekMode === 'manual';
    const limitWeek = isManual ? (this.state.manualWeek || 1) : cycle.autoWeek;

    for (let w = 1; w < limitWeek; w++) {
      const wData = this.getWeekData(w);
      if (wData.surplusStatus === 'archived' || wData.surplusStatus === 'resolved') {
        continue;
      }
      const rem = this.getWeeklyRemaining(w);
      if (rem > 0 && wData.surplusStatus === 'none') {
        wData.surplusStatus = 'pending';
      }
    }
  }

  getFirstPendingSurplusWeek() {
    const cycle = this.getCycleInfo();
    const isManual = this.state.weekMode === 'manual';
    const limitWeek = isManual ? (this.state.manualWeek || 1) : cycle.autoWeek;

    for (let w = 1; w < limitWeek; w++) {
      const wData = this.getWeekData(w);
      if (wData.surplusStatus === 'archived' || wData.surplusStatus === 'resolved') {
        continue;
      }
      const rem = this.getWeeklyRemaining(w);
      if (rem > 0 && wData.surplusStatus === 'pending') {
        return w;
      }
    }
    return null;
  }

  // Opens the requested decision modal for a specific week's surplus
  openWeekDecisionModal(weekNum) {
    const surplus = this.getWeeklyRemaining(weekNum);
    if (surplus <= 0) {
      alert(`A(z) ${weekNum}. héten nincs fennmaradó pozitív maradványkeret.`);
      return;
    }

    this.activeDecisionWeek = weekNum;

    const titleEl = document.getElementById('decisionModalWeekTitle');
    const amountEl = document.getElementById('decisionModalSurplusAmount');
    const selector = document.getElementById('decisionGoalSelector');
    const nextBtn = document.getElementById('btnDecisionToNextWeek');
    const nextDesc = document.getElementById('decisionNextWeekDesc');

    if (titleEl) titleEl.textContent = `Az ${weekNum}. hét lezárult. Fennmaradó összeg: ${this.formatFt(surplus)}`;
    if (amountEl) amountEl.textContent = this.formatFt(surplus);
    if (selector) selector.classList.add('hidden');

    if (nextBtn && nextDesc) {
      if (weekNum >= 4) {
        nextBtn.classList.add('opacity-50');
        nextDesc.textContent = 'A 4. hét az utolsó hét a ciklusban. A fennmaradó összeget célhoz érdemes átutalni!';
      } else {
        nextBtn.classList.remove('opacity-50');
        nextDesc.textContent = `Megnöveli a(z) ${weekNum + 1}. hét keretét ezzel az összeggel (+${this.formatFt(surplus)}).`;
      }
    }

    const modal = document.getElementById('weekClosedDecisionModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  closeWeekDecisionModal() {
    const modal = document.getElementById('weekClosedDecisionModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    this.activeDecisionWeek = null;
  }

  // Decision Button 1: Hozzáadás a következő héthez (Rollover)
  decisionAddToNextWeek(targetWeekNum = null) {
    const w = targetWeekNum || this.activeDecisionWeek || this.getActiveWeek();
    const surplus = this.getWeeklyRemaining(w);

    if (surplus <= 0) {
      this.closeWeekDecisionModal();
      return;
    }

    if (w >= 4) {
      alert('A 4. hét az utolsó hét a 15-ei ciklusban. A megmaradt összeget érdemes megtakarítási célhoz átutalni!');
      return;
    }

    const nextWeek = this.getWeekData(w + 1);
    nextWeek.rollover = (Number(nextWeek.rollover) || 0) + surplus;
    nextWeek.hasManualRollover = true;

    const wData = this.getWeekData(w);
    wData.surplusStatus = 'resolved';
    wData.transferredToNextWeek = surplus;
    wData.transferredOut = (Number(wData.transferredOut) || 0) + surplus;

    this.state.history.unshift({
      id: 'tx-' + Date.now(),
      date: new Date().toLocaleDateString('hu-HU'),
      title: `${w}. heti maradvány átvezetve a(z) ${w + 1}. hétre`,
      amount: surplus,
      breakdown: `${w + 1}. heti kerethez hozzáadva: +${this.formatFt(surplus)} (Rollover)`
    });

    this.closeWeekDecisionModal();
    this.saveState();
    this.showToast(`+${this.formatFt(surplus)} sikeresen hozzáadva a(z) ${w + 1}. hét keretéhez!`, '⏩');
  }

  // Decision Button 2: Átutalás megtakarítási célhoz -> shows goals
  decisionShowGoalSelection(targetWeekNum = null) {
    if (targetWeekNum) this.activeDecisionWeek = targetWeekNum;
    const selector = document.getElementById('decisionGoalSelector');
    const list = document.getElementById('decisionGoalsList');
    if (!selector || !list) return;

    const w = this.activeDecisionWeek || this.getActiveWeek();
    const surplus = this.getWeeklyRemaining(w);

    selector.classList.remove('hidden');

    if (this.state.goals.length === 0) {
      list.innerHTML = `<div class="p-2 text-xs text-rose-400">Nincsenek létrehozott megtakarítási célok. Hozz létre egyet a Célok fülön!</div>`;
      return;
    }

    list.innerHTML = this.state.goals.map(goal => `
      <button type="button" onclick="app.decisionTransferToGoal('${goal.id}')" class="w-full p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-left transition flex items-center justify-between group active:scale-[0.98]">
        <div>
          <span class="text-xs font-bold text-white group-hover:text-emerald-300">🎯 ${this.escapeHtml(goal.name)}</span>
          <span class="text-[10px] text-slate-400 block">Jelenleg: ${this.formatFt(goal.current)} / ${this.formatFt(goal.target)}</span>
        </div>
        <span class="text-xs font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2 py-1 rounded-lg">
          +${this.formatFt(surplus)}
        </span>
      </button>
    `).join('');
  }

  decisionTransferToGoal(goalId, targetWeekNum = null) {
    const w = targetWeekNum || this.activeDecisionWeek || this.getActiveWeek();
    const surplus = this.getWeeklyRemaining(w);
    const goal = this.state.goals.find(g => g.id === goalId);

    if (!goal || surplus <= 0) return;

    goal.current = (Number(goal.current) || 0) + surplus;

    const wData = this.getWeekData(w);
    wData.surplusStatus = 'resolved';
    wData.transferredOut = (Number(wData.transferredOut) || 0) + surplus;

    this.state.history.unshift({
      id: 'tx-' + Date.now(),
      date: new Date().toLocaleDateString('hu-HU'),
      title: `${w}. heti maradvány megtakarítva`,
      amount: surplus,
      breakdown: `${goal.name}: +${this.formatFt(surplus)}`
    });

    this.closeWeekDecisionModal();
    this.saveState();
    this.showToast(`+${this.formatFt(surplus)} átutalva a(z) "${goal.name}" célhoz!`, '🎯');
  }

  // End of week choice from the week status card: prompts user decision
  promptCloseWeekRoll() {
    const w = this.getActiveWeek();
    const remaining = this.getWeeklyRemaining(w);

    if (remaining <= 0) {
      if (w < 4) {
        this.selectWeek(w + 1);
        this.showToast(`Átváltva a(z) ${w + 1}. hétre. A túlköltekezés érvényesítve.`, 'ℹ️');
      } else {
        alert('A 4. hét lezárult.');
      }
      return;
    }

    this.openWeekDecisionModal(w);
  }

  openSurplusToSavingsModal() {
    const w = this.getActiveWeek();
    const remaining = this.getWeeklyRemaining(w);

    if (remaining <= 0) {
      alert('Az aktuális héten nincs pozitív maradványkeret, amit megtakarításba tehetnél.');
      return;
    }

    this.openWeekDecisionModal(w);
    this.decisionShowGoalSelection();
  }

  // ==========================================
  // DIRECT EDIT OF ALL WEEK VALUES (Manual Override)
  // ==========================================
  openEditWeekValuesModal(focusField = 'base') {
    this.editModalSelectedWeek = this.getActiveWeek();
    this.updateEditModalFields(focusField);
    const modal = document.getElementById('editWeekValuesModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  closeEditWeekValuesModal() {
    const modal = document.getElementById('editWeekValuesModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  switchEditModalWeek(weekNum) {
    this.editModalSelectedWeek = weekNum;
    this.updateEditModalFields();
  }

  updateEditModalFields(focusField = null) {
    const w = this.editModalSelectedWeek || this.getActiveWeek();
    const wData = this.getWeekData(w);
    const baseBudget = this.getBaseBudgetForWeek(w);
    const rollover = Number(wData.rollover) || 0;
    const remaining = this.getWeeklyRemaining(w);

    const titleEl = document.getElementById('editValuesModalTitle');
    if (titleEl) titleEl.textContent = `A(z) ${w}. hét értékeinek korrekciója`;

    [1, 2, 3, 4].forEach(n => {
      const btn = document.getElementById(`editWeekBtn-${n}`);
      if (btn) {
        if (n === w) {
          btn.className = 'py-1.5 px-2 rounded-lg text-xs font-bold transition bg-cyan-600 text-white border border-cyan-500 shadow';
        } else {
          btn.className = 'py-1.5 px-2 rounded-lg text-xs font-bold transition bg-slate-800 text-slate-300 border border-slate-700';
        }
      }
    });

    const baseInput = document.getElementById('editModalBaseBudget');
    if (baseInput) baseInput.value = baseBudget;

    const rollInput = document.getElementById('editModalRollover');
    if (rollInput) rollInput.value = rollover;

    const remInput = document.getElementById('editModalRemaining');
    if (remInput) {
      remInput.value = remaining;
    }

    if (focusField === 'base' && baseInput) {
      setTimeout(() => { baseInput.focus(); baseInput.select(); }, 120);
    } else if (focusField === 'rollover' && rollInput) {
      setTimeout(() => { rollInput.focus(); rollInput.select(); }, 120);
    } else if (focusField === 'remaining' && remInput) {
      setTimeout(() => { remInput.focus(); remInput.select(); }, 120);
    }
  }

  calcEditModalRemainingFromFormula() {
    const w = this.editModalSelectedWeek || this.getActiveWeek();
    const base = parseInt(document.getElementById('editModalBaseBudget')?.value, 10) || 0;
    const roll = parseInt(document.getElementById('editModalRollover')?.value, 10) || 0;
    const spent = this.getWeeklySpent(w);
    const remInput = document.getElementById('editModalRemaining');
    if (remInput) {
      remInput.value = base + roll - spent;
    }
  }

  handleSaveWeekValues(e) {
    e.preventDefault();
    const w = this.editModalSelectedWeek || this.getActiveWeek();
    const wData = this.getWeekData(w);

    const baseVal = parseInt(document.getElementById('editModalBaseBudget')?.value, 10);
    const rollVal = parseInt(document.getElementById('editModalRollover')?.value, 10);
    const remInput = document.getElementById('editModalRemaining');
    const remVal = remInput && remInput.value !== '' ? parseInt(remInput.value, 10) : NaN;

    if (isNaN(baseVal) || baseVal < 0) {
      alert('Kérlek adj meg érvényes heti induló keretet!');
      return;
    }

    wData.customBaseBudget = baseVal;
    wData.rollover = isNaN(rollVal) ? 0 : rollVal;
    wData.hasManualRollover = true;

    if (!isNaN(remVal)) {
      wData.manualRemaining = remVal;
    } else {
      wData.manualRemaining = null;
    }

    this.selectWeekManual(w);
    this.updateRolloversChain();
    this.closeEditWeekValuesModal();
    this.saveState();
    this.showToast(`A(z) ${w}. hét értékei sikeresen korrigálva!`, '💾');
  }

  resetWeekFormulas() {
    const w = this.editModalSelectedWeek || this.getActiveWeek();
    const wData = this.getWeekData(w);
    wData.manualRemaining = null;
    wData.hasManualRollover = false;
    wData.customBaseBudget = null;

    this.updateRolloversChain();
    this.closeEditWeekValuesModal();
    this.saveState();
    this.showToast(`A(z) ${w}. hét kézi felülbírálásai törölve, képletek visszaállítva!`, '↺');
  }

  // ==========================================
  // RESET CYCLE & MID-CYCLE START (Hétközi indítás)
  // ==========================================
  openResetCycleModal() {
    const cycle = this.getCycleInfo();
    this.resetCycleSelectedWeek = this.state.weekMode === 'manual' ? (this.state.manualWeek || 1) : cycle.autoWeek;
    this.updateResetCycleModalUI();
    const modal = document.getElementById('resetCycleModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  closeResetCycleModal() {
    const modal = document.getElementById('resetCycleModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  setResetCycleWeek(weekNum) {
    this.resetCycleSelectedWeek = weekNum;
    this.updateResetCycleModalUI();
  }

  updateResetCycleModalUI() {
    const w = this.resetCycleSelectedWeek || 3;
    [1, 2, 3, 4].forEach(n => {
      const btn = document.getElementById(`resetWeekBtn-${n}`);
      if (btn) {
        if (n === w) {
          btn.className = 'py-2 px-2 rounded-lg text-xs font-bold transition bg-amber-500 text-slate-950 border border-amber-400 shadow';
        } else {
          btn.className = 'py-2 px-2 rounded-lg text-xs font-bold transition bg-slate-800 text-slate-300 border border-slate-700';
        }
      }
    });
  }

  confirmMidCycleStart() {
    const startWeek = this.resetCycleSelectedWeek || 3;
    const input = document.getElementById('resetCycleStartBudget');
    const startAmount = parseInt(input?.value, 10);

    if (isNaN(startAmount) || startAmount < 0) {
      alert('Kérlek adj meg érvényes kezdő összeget!');
      return;
    }

    for (let w = 1; w <= 4; w++) {
      const wD = this.getWeekData(w);
      if (w < startWeek) {
        wD.expenses = [];
        wD.rollover = 0;
        wD.hasManualRollover = true;
        wD.surplusStatus = 'archived';
        wD.customBaseBudget = 0;
        wD.transferredOut = 0;
        wD.transferredToNextWeek = 0;
        wD.manualRemaining = 0;
      } else if (w === startWeek) {
        wD.expenses = [];
        wD.rollover = 0;
        wD.hasManualRollover = true;
        wD.surplusStatus = 'none';
        wD.customBaseBudget = startAmount;
        wD.transferredOut = 0;
        wD.transferredToNextWeek = 0;
        wD.manualRemaining = startAmount;
      } else {
        wD.expenses = [];
        wD.rollover = 0;
        wD.hasManualRollover = false;
        wD.surplusStatus = 'none';
        wD.customBaseBudget = null;
        wD.transferredOut = 0;
        wD.transferredToNextWeek = 0;
        wD.manualRemaining = null;
      }
    }

    this.state.weekMode = 'manual';
    this.state.manualWeek = startWeek;
    this.viewWeek = startWeek;
    this.closeResetCycleModal();
    this.saveState();
    this.showToast(`Ciklus sikeresen elindítva a(z) ${startWeek}. héttel (${this.formatFt(startAmount)})!`, '🚀');
  }

  confirmResetAllWeeksToDefault() {
    this.askConfirm(
      'Teljes ciklus újraindítása',
      'Biztosan törlöd az összes eddigi heti költést, és visszaállítod az 1. héttől induló tiszta alapkeretet?',
      () => {
        for (let w = 1; w <= 4; w++) {
          const wD = this.getWeekData(w);
          wD.expenses = [];
          wD.rollover = 0;
          wD.hasManualRollover = false;
          wD.surplusStatus = 'none';
          wD.customBaseBudget = null;
          wD.transferredOut = 0;
          wD.transferredToNextWeek = 0;
          wD.manualRemaining = null;
        }
        this.state.weekMode = 'auto';
        this.state.manualWeek = null;
        this.viewWeek = 1;
        this.closeResetCycleModal();
        this.saveState();
        this.showToast('Minden hét alaphelyzetbe állítva (tiszta 1. hét)!', '🔄');
      }
    );
  }

  handleAddExpense(e) {
    e.preventDefault();
    const amountInput = document.getElementById('expenseAmount');
    const noteInput = document.getElementById('expenseNote');
    const categoryRadio = document.querySelector('input[name="expenseCategoryRadio"]:checked');
    const amount = parseInt(amountInput.value, 10);
    const note = noteInput.value.trim();
    const category = categoryRadio ? categoryRadio.value : 'hasznos';

    if (isNaN(amount) || amount <= 0 || !note) {
      alert('Kérlek adj meg érvényes összeget és megjegyzést!');
      return;
    }

    const currentWeekNum = this.getActiveWeek();
    const weekData = this.getWeekData(currentWeekNum);

    const newExpense = {
      id: 'exp-' + Date.now(),
      amount,
      note,
      category,
      date: new Date().toLocaleDateString('hu-HU') + ' ' + new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
    };

    weekData.expenses.unshift(newExpense);
    if (weekData.manualRemaining !== null && weekData.manualRemaining !== undefined) {
      weekData.manualRemaining = Math.round(Number(weekData.manualRemaining) - amount);
    }
    this.updateRolloversChain();

    amountInput.value = '';
    noteInput.value = '';
    this.saveState();
    this.showToast(`Kiadás rögzítve: -${this.formatFt(amount)} (${note}) [${category === 'szórakozás' ? '🎭 Szórakozás' : '🛒 Hasznos'}]`, '💸');
  }

  quickExpense(amount, note, category = 'hasznos') {
    const currentWeekNum = this.getActiveWeek();
    const weekData = this.getWeekData(currentWeekNum);

    weekData.expenses.unshift({
      id: 'exp-' + Date.now(),
      amount,
      note,
      category,
      date: new Date().toLocaleDateString('hu-HU') + ' ' + new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
    });

    if (weekData.manualRemaining !== null && weekData.manualRemaining !== undefined) {
      weekData.manualRemaining = Math.round(Number(weekData.manualRemaining) - amount);
    }

    this.updateRolloversChain();
    this.saveState();
    this.showToast(`Gyorsgomb: -${this.formatFt(amount)} (${note}) [${category === 'szórakozás' ? '🎭' : '🛒'}]`, '🍔');
  }

  deleteExpense(expenseId) {
    const currentWeekNum = this.getActiveWeek();
    const weekData = this.getWeekData(currentWeekNum);
    const exp = weekData.expenses.find(x => x.id === expenseId);
    if (!exp) return;

    this.askConfirm(
      'Kiadás törlése',
      `Törölni szeretnéd ezt a heti kiadást: "${exp.note}" (-${this.formatFt(exp.amount)})?`,
      () => {
        weekData.expenses = weekData.expenses.filter(x => x.id !== expenseId);
        if (weekData.manualRemaining !== null && weekData.manualRemaining !== undefined) {
          weekData.manualRemaining = Math.round(Number(weekData.manualRemaining) + Number(exp.amount));
        }
        this.updateRolloversChain();
        this.saveState();
        this.showToast('Kiadás törölve!', '🗑️');
      }
    );
  }

  updateRolloversChain() {
    for (let w = 1; w < 4; w++) {
      const nextWeek = this.getWeekData(w + 1);

      // Ha a felhasználó kézzel megadta a következő hét áthozatát, tartsuk tiszteletben
      if (nextWeek.hasManualRollover) {
        continue;
      }

      const wData = this.getWeekData(w);
      if (wData.surplusStatus === 'archived') {
        nextWeek.rollover = 0;
        continue;
      }

      // Képlet: Különbözet = (Adott heti induló keret) - (Adott héten elköltött összeg)
      let diff;
      if (wData.manualRemaining !== null && wData.manualRemaining !== undefined) {
        diff = Number(wData.manualRemaining);
      } else {
        const startBudget = this.getEffectiveWeeklyBudget(w);
        const spent = this.getWeeklySpent(w);
        diff = startBudget - spent;
      }

      if (diff === 0) {
        // Pont elköltötte a keretet (pl. 15 000 - 15 000): Az áthozat 0 Ft!
        nextWeek.rollover = 0;
      } else if (diff < 0) {
        // Túlköltekezés (pl. elköltött 18 000 Ft-ot): A hiány -3 000 Ft, ekkor az áthozat -3 000 Ft!
        nextWeek.rollover = diff;
      } else {
        // Különbözet > 0 (megmaradt pénz):
        // Csak akkor adódik hozzá a kövi héthez, ha a felhasználó kifejezetten a "Hozzáadás" gombra nyomott!
        // Alapértelmezésben NE hozzon át virtuális többletet a múltból!
        if (wData.surplusStatus === 'resolved' && wData.transferredToNextWeek) {
          nextWeek.rollover = Number(wData.transferredToNextWeek) || 0;
        } else {
          nextWeek.rollover = 0;
        }
      }
    }
  }

  // ==========================================
  // SECTION 6: RECEIPT PHOTO OCR SCANNER (AI)
  // ==========================================
  triggerScanReceipt() {
    const input = document.getElementById('receiptFileInput');
    if (input) {
      input.value = '';
      input.click();
    }
  }

  async handleReceiptFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const modal = document.getElementById('receiptScanModal');
    const previewImg = document.getElementById('receiptPreviewImg');
    const anim = document.getElementById('receiptScanningAnimation');
    const amountInput = document.getElementById('scannedAmount');
    const merchantInput = document.getElementById('scannedMerchant');
    const summaryText = document.getElementById('scannedSummaryText');
    const catSzorakozas = document.getElementById('scannedCatSzorakozas');
    const catHasznos = document.getElementById('scannedCatHasznos');

    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    if (anim) anim.classList.remove('hidden');
    if (previewImg) previewImg.classList.add('hidden');
    if (amountInput) amountInput.value = '';
    if (merchantInput) merchantInput.value = '';
    if (summaryText) summaryText.textContent = 'Elemzés folyamatban...';

    const reader = new FileReader();
    reader.onload = async (event) => {
      const dataUrl = event.target?.result;
      if (!dataUrl) return;

      if (previewImg) {
        previewImg.src = dataUrl;
        previewImg.classList.remove('hidden');
      }

      const base64Data = String(dataUrl).split(',')[1];
      const mimeType = file.type || 'image/jpeg';

      try {
        const response = await fetch('/api/scan-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64Data, mimeType })
        });

        const resData = await response.json();
        if (anim) anim.classList.add('hidden');

        if (response.ok && resData.success) {
          if (amountInput) amountInput.value = resData.amount || 0;
          if (merchantInput) merchantInput.value = resData.merchant || 'Vásárlás';
          if (summaryText) summaryText.textContent = resData.itemsSummary || 'Sikeres kiolvasás!';

          if (resData.category === 'szórakozás') {
            if (catSzorakozas) catSzorakozas.checked = true;
          } else {
            if (catHasznos) catHasznos.checked = true;
          }

          this.showToast(`Blokk kiolvasva: ${this.formatFt(resData.amount || 0)} (${resData.merchant})`, '📸');
        } else {
          if (summaryText) summaryText.textContent = resData.error || 'A blokk képe alapján nem sikerült automatikusan kiolvasni. Kérlek írd be kézzel az adatokat.';
          this.showToast('Nem sikerült kiolvasni a blokkot, kérlek add meg kézzel!', '⚠️');
        }
      } catch (err) {
        console.error('Scan fetch error:', err);
        if (anim) anim.classList.add('hidden');
        if (summaryText) summaryText.textContent = 'Nem sikerült elérni az AI szolgáltatást. Kérlek írd be kézzel az adatokat.';
      }
    };
    reader.readAsDataURL(file);
  }

  closeScanModal() {
    const modal = document.getElementById('receiptScanModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  confirmScannedExpense() {
    const amountInput = document.getElementById('scannedAmount');
    const merchantInput = document.getElementById('scannedMerchant');
    const catRadio = document.querySelector('input[name="scannedCategoryRadio"]:checked');

    const amount = parseInt(amountInput?.value, 10);
    const merchant = merchantInput?.value.trim() || 'Blokk vásárlás';
    const category = catRadio ? catRadio.value : 'hasznos';

    if (isNaN(amount) || amount <= 0) {
      alert('Kérlek adj meg érvényes összeget a mentéshez!');
      return;
    }

    const currentWeekNum = this.getActiveWeek();
    const weekData = this.getWeekData(currentWeekNum);

    weekData.expenses.unshift({
      id: 'exp-' + Date.now(),
      amount,
      note: merchant,
      category,
      date: new Date().toLocaleDateString('hu-HU') + ' ' + new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
    });

    if (weekData.manualRemaining !== null && weekData.manualRemaining !== undefined) {
      weekData.manualRemaining = Math.round(Number(weekData.manualRemaining) - amount);
    }

    this.updateRolloversChain();
    this.closeScanModal();
    this.saveState();
    this.showToast(`Blokk elmentve: -${this.formatFt(amount)} (${merchant}) [${category === 'szórakozás' ? '🎭' : '🛒'}]`, '✅');
  }

  // ==========================================
  // SECTION 7: ANALYTICS & CHARTS
  // ==========================================
  setAnalyticsTimeframe(tf) {
    this.analyticsTimeframe = tf;
    ['day', 'month', 'year', 'all'].forEach(t => {
      const btn = document.getElementById(`tf-${t}`);
      if (btn) {
        if (t === tf) {
          btn.className = 'px-2.5 py-1 rounded-lg text-xs font-bold transition bg-emerald-500 text-slate-950 shadow-sm';
        } else {
          btn.className = 'px-2.5 py-1 rounded-lg text-xs font-bold transition text-slate-400 hover:text-white';
        }
      }
    });
    this.renderAnalyticsSection();
  }

  getAllExpenses() {
    const all = [];
    for (let w = 1; w <= 4; w++) {
      const wExpenses = this.state.weeks?.[w]?.expenses || [];
      all.push(...wExpenses);
    }
    return all;
  }

  parseExpenseDate(dateStr) {
    if (!dateStr) return new Date();
    try {
      const parts = dateStr.split(' ')[0].replace(/\./g, ' ').trim().split(/\s+/);
      if (parts.length >= 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const d = parseInt(parts[2], 10);
        return new Date(y, m, d);
      }
    } catch {}
    return new Date();
  }

  renderAnalyticsSection() {
    const allExpenses = this.getAllExpenses();
    const now = new Date();
    const todayStr = now.toLocaleDateString('hu-HU');
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const filteredExpenses = allExpenses.filter(exp => {
      if (!exp.date) return true;
      const d = this.parseExpenseDate(exp.date);
      if (this.analyticsTimeframe === 'day') {
        return exp.date.startsWith(todayStr) || (d.getDate() === now.getDate() && d.getMonth() === currentMonth && d.getFullYear() === currentYear);
      } else if (this.analyticsTimeframe === 'month') {
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      } else if (this.analyticsTimeframe === 'year') {
        return d.getFullYear() === currentYear;
      }
      return true;
    });

    let funAmount = 0;
    let usefulAmount = 0;

    filteredExpenses.forEach(exp => {
      const amt = Number(exp.amount) || 0;
      if (exp.category === 'szórakozás') {
        funAmount += amt;
      } else {
        usefulAmount += amt;
      }
    });

    const totalSpent = funAmount + usefulAmount;
    const funPercent = totalSpent > 0 ? Math.round((funAmount / totalSpent) * 100) : 0;
    const usefulPercent = totalSpent > 0 ? (100 - funPercent) : 0;

    const periodLabelEl = document.getElementById('analyticsPeriodLabel');
    if (periodLabelEl) {
      periodLabelEl.textContent = this.analyticsTimeframe === 'day' ? 'Mai nap költései'
        : this.analyticsTimeframe === 'month' ? 'Aktuális hónap'
        : this.analyticsTimeframe === 'year' ? `${currentYear}. év költései`
        : 'Minden rögzített költés';
    }

    const totalEl = document.getElementById('analyticsTotalSpent');
    if (totalEl) totalEl.textContent = this.formatFt(totalSpent);

    const funAmountEl = document.getElementById('analyticsFunAmount');
    if (funAmountEl) funAmountEl.textContent = this.formatFt(funAmount);
    const funPercentEl = document.getElementById('analyticsFunPercent');
    if (funPercentEl) funPercentEl.textContent = `${funPercent}%`;

    const usefulAmountEl = document.getElementById('analyticsUsefulAmount');
    if (usefulAmountEl) usefulAmountEl.textContent = this.formatFt(usefulAmount);
    const usefulPercentEl = document.getElementById('analyticsUsefulPercent');
    if (usefulPercentEl) usefulPercentEl.textContent = `${usefulPercent}%`;

    const legUseful = document.getElementById('legendUsefulText');
    if (legUseful) legUseful.textContent = `${usefulPercent}% (${this.formatFt(usefulAmount)})`;
    const legFun = document.getElementById('legendFunText');
    if (legFun) legFun.textContent = `${funPercent}% (${this.formatFt(funAmount)})`;

    const donutCenter = document.getElementById('donutRatioCenter');
    if (donutCenter) donutCenter.textContent = totalSpent > 0 ? `${usefulPercent}%` : '0%';

    const donutUsefulPath = document.getElementById('donutUsefulPath');
    const donutFunPath = document.getElementById('donutFunPath');

    if (donutUsefulPath && donutFunPath) {
      if (totalSpent === 0) {
        donutUsefulPath.setAttribute('stroke-dasharray', '0, 100');
        donutFunPath.setAttribute('stroke-dasharray', '0, 100');
      } else {
        donutUsefulPath.setAttribute('stroke-dasharray', `${usefulPercent}, 100`);
        donutUsefulPath.setAttribute('stroke-dashoffset', '0');

        donutFunPath.setAttribute('stroke-dasharray', `${funPercent}, 100`);
        donutFunPath.setAttribute('stroke-dashoffset', `-${usefulPercent}`);
      }
    }

    const insightText = document.getElementById('analyticsInsightText');
    if (insightText) {
      if (totalSpent === 0) {
        insightText.innerHTML = 'Ebben az időszakban még nem rögzítettél kiadást. Rögzíts kiadást vagy fotózz be egy blokkot!';
      } else if (funPercent > 60) {
        insightText.innerHTML = `<span class="text-rose-400 font-bold">Magas szórakozási arány (${funPercent}%):</span> A kiadásaid túlnyomó része szórakozásra és kényelmi cikkekre ment el. Érdemes lehet visszafogni a nem létszükségletű költéseket a céljaid eléréséhez.`;
      } else if (funPercent >= 30) {
        insightText.innerHTML = `<span class="text-amber-300 font-bold">Kiegyensúlyozott arány (${funPercent}% szórakozás / ${usefulPercent}% hasznos):</span> Egészséges egyensúlyban tartod a kikapcsolódást és a kötelező hasznos kiadásokat.`;
      } else {
        insightText.innerHTML = `<span class="text-emerald-400 font-bold">Kiváló pénzügyi fegyelem (${usefulPercent}% hasznos):</span> A pénzed túlnyomó része létszükségletre, kötelező eszközökre és hasznos dolgokra ment!`;
      }
    }

    this.renderMonthlyExtraIncomeGraph();
  }

  renderMonthlyExtraIncomeGraph() {
    const history = this.state.history || [];
    const positiveIncomes = history.filter(h => Number(h.amount) > 0);

    const monthNames = ['Jan', 'Feb', 'Már', 'Ápr', 'Máj', 'Jún', 'Júl', 'Aug', 'Szept', 'Okt', 'Nov', 'Dec'];
    const now = new Date();
    const monthlyData = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mIdx = d.getMonth();
      const y = d.getFullYear();
      const key = `${y}-${String(mIdx + 1).padStart(2, '0')}`;
      monthlyData.push({
        key,
        year: y,
        monthIndex: mIdx,
        monthName: monthNames[mIdx],
        total: 0,
        count: 0,
        items: []
      });
    }

    positiveIncomes.forEach(item => {
      let itemDate = now;
      if (item.date) {
        try {
          const parts = item.date.split(' ')[0].replace(/\./g, ' ').trim().split(/\s+/);
          if (parts.length >= 2) {
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10) - 1;
            itemDate = new Date(y, m, 1);
          }
        } catch {}
      }

      const key = `${itemDate.getFullYear()}-${String(itemDate.getMonth() + 1).padStart(2, '0')}`;
      const found = monthlyData.find(m => m.key === key);
      const amt = Number(item.amount) || 0;

      if (found) {
        found.total += amt;
        found.count += 1;
        found.items.push(item);
      } else {
        const latest = monthlyData[monthlyData.length - 1];
        if (latest) {
          latest.total += amt;
          latest.count += 1;
          latest.items.push(item);
        }
      }
    });

    const totalExtraAll = monthlyData.reduce((sum, m) => sum + m.total, 0);
    const activeMonthsCount = monthlyData.filter(m => m.total > 0).length || 1;
    const monthlyAvg = Math.round(totalExtraAll / activeMonthsCount);

    let bestMonth = monthlyData[0];
    monthlyData.forEach(m => {
      if (m.total > bestMonth.total) bestMonth = m;
    });

    const latestMonth = monthlyData[monthlyData.length - 1];
    const prevMonth = monthlyData[monthlyData.length - 2];
    const trendBadge = document.getElementById('extraIncomeTrendBadge');

    if (trendBadge) {
      if (latestMonth.total > prevMonth.total) {
        const diff = latestMonth.total - prevMonth.total;
        const pct = prevMonth.total > 0 ? Math.round((diff / prevMonth.total) * 100) : 100;
        trendBadge.className = 'px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 bg-emerald-950/60 text-emerald-400 border border-emerald-800/60';
        trendBadge.innerHTML = `<span>📈 Növekvő tendencia (+${pct}%)</span>`;
      } else if (latestMonth.total < prevMonth.total && latestMonth.total > 0) {
        const diff = prevMonth.total - latestMonth.total;
        const pct = prevMonth.total > 0 ? Math.round((diff / prevMonth.total) * 100) : 0;
        trendBadge.className = 'px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 bg-amber-950/60 text-amber-300 border border-amber-800/60';
        trendBadge.innerHTML = `<span>📉 Csökkenő tendencia (-${pct}%)</span>`;
      } else {
        trendBadge.className = 'px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 bg-cyan-950/60 text-cyan-300 border border-cyan-800/60';
        trendBadge.innerHTML = `<span>⚖️ Kiegyensúlyozott kereset</span>`;
      }
    }

    const totalExtraEl = document.getElementById('trendTotalExtra');
    if (totalExtraEl) totalExtraEl.textContent = this.formatFt(totalExtraAll);

    const monthlyAvgEl = document.getElementById('trendMonthlyAverage');
    if (monthlyAvgEl) monthlyAvgEl.textContent = this.formatFt(monthlyAvg);

    const bestMonthEl = document.getElementById('trendBestMonth');
    if (bestMonthEl) bestMonthEl.textContent = bestMonth && bestMonth.total > 0 ? `${bestMonth.monthName}` : '-';

    const bestMonthAmtEl = document.getElementById('trendBestMonthAmount');
    if (bestMonthAmtEl) bestMonthAmtEl.textContent = bestMonth && bestMonth.total > 0 ? this.formatFt(bestMonth.total) : '0 Ft';

    const chartContainer = document.getElementById('monthlyBarChartContainer');
    if (chartContainer) {
      const maxVal = Math.max(10000, ...monthlyData.map(m => m.total));

      chartContainer.innerHTML = monthlyData.map((m, idx) => {
        const heightPct = Math.max(6, Math.round((m.total / maxVal) * 100));
        const isCurrent = idx === monthlyData.length - 1;

        return `
          <div class="flex-1 flex flex-col items-center justify-end h-full group relative">
            <div class="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-8 bg-slate-900 text-white text-[10px] font-bold py-1 px-2 rounded-lg border border-slate-700 pointer-events-none whitespace-nowrap z-10 shadow-lg">
              ${m.monthName}: ${this.formatFt(m.total)} (${m.count} tétel)
            </div>

            <div class="text-[10px] font-bold mb-1 truncate text-center ${isCurrent ? 'text-emerald-400' : 'text-slate-400'}">
              ${m.total > 0 ? (m.total >= 1000 ? Math.round(m.total / 1000) + 'k' : m.total) : '0'}
            </div>

            <div class="w-full max-w-[42px] bg-slate-900 rounded-t-xl overflow-hidden flex items-end justify-center p-0.5" style="height: 100%;">
              <div class="w-full rounded-t-lg transition-all duration-700 ease-out ${isCurrent ? 'bg-gradient-to-t from-emerald-600 to-teal-400 shadow-lg shadow-emerald-500/20' : (m.total > 0 ? 'bg-gradient-to-t from-emerald-800/80 to-teal-600/80' : 'bg-slate-800/40')}" style="height: ${heightPct}%;"></div>
            </div>

            <span class="text-[10px] font-semibold mt-1.5 ${isCurrent ? 'text-emerald-400 font-bold' : 'text-slate-400'}">
              ${m.monthName}
            </span>
          </div>
        `;
      }).join('');
    }

    const detailsList = document.getElementById('monthlyIncomeDetailsList');
    if (detailsList) {
      if (positiveIncomes.length === 0) {
        detailsList.innerHTML = `<div class="p-3 text-center text-xs text-slate-500 bg-slate-950/60 rounded-xl border border-slate-800">Még nincs rögzített plusz bevétel. Használd a gyorsgombokat vagy a Változó Bevétel űrlapot!</div>`;
      } else {
        detailsList.innerHTML = positiveIncomes.map(item => `
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 hover:border-slate-700 text-xs flex items-center justify-between">
            <div>
              <span class="font-bold text-slate-200 block">${this.escapeHtml(item.title)}</span>
              <span class="text-[10px] text-slate-400">${item.date} ${item.breakdown ? '• ' + this.escapeHtml(item.breakdown) : ''}</span>
            </div>
            <span class="font-black text-emerald-400 text-xs shrink-0 ml-2">+${this.formatFt(item.amount)}</span>
          </div>
        `).join('');
      }
    }
  }

  // ==========================================
  // BACKUP / EXPORT / IMPORT
  // ==========================================
  openBackupModal() {
    const modal = document.getElementById('backupModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  closeBackupModal() {
    const modal = document.getElementById('backupModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  exportData() {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.state, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `penzugyi_tervezo_mentes_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.showToast('Adatok sikeresen letöltve!', '📁');
  }

  importData(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (parsed && typeof parsed === 'object') {
          this.state = {
            ...DEFAULT_STATE,
            ...parsed,
            weekMode: parsed.weekMode || 'auto',
            manualWeek: parsed.manualWeek || null,
            quickButtons: Array.isArray(parsed.quickButtons) && parsed.quickButtons.length > 0
              ? parsed.quickButtons
              : (this.state.quickButtons || DEFAULT_STATE.quickButtons),
            history: Array.isArray(parsed.history)
              ? parsed.history.map((h, i) => ({
                  id: h.id || `tx-${Date.now()}-${i}`,
                  date: h.date || new Date().toLocaleDateString('hu-HU'),
                  title: h.title || 'Tranzakció',
                  amount: typeof h.amount === 'number' ? h.amount : (parseInt(h.amount, 10) || 0),
                  breakdown: h.breakdown || '',
                }))
              : (this.state.history || DEFAULT_STATE.history),
          };
          this.viewWeek = null;
          this.saveState();
          this.closeBackupModal();
          this.showToast('Adatok sikeresen visszaállítva!', '✅');
        } else {
          alert('Érvénytelen mentési fájl formátum!');
        }
      } catch (err) {
        alert('Hiba történt a fájl beolvasásakor: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================
  // RENDER UI & COMPONENTS
  // ==========================================
  render() {
    this.renderQuickButtons();
    this.renderFixedSection();
    this.renderGoalsSection();
    this.renderWeeklySection();
    if (this.currentTab === 'analytics') {
      this.renderAnalyticsSection();
    }
  }

  renderFixedSection() {
    const guaranteed = Number(this.state.guaranteedIncome) || 0;
    const totalFixed = this.getTotalFixedExpenses();
    const freeBudget = this.getBaseFreeBudget();
    const weeklyFree = Math.round(freeBudget / 4);

    const incomeInput = document.getElementById('guaranteedIncomeInput');
    if (incomeInput && document.activeElement !== incomeInput) {
      incomeInput.value = guaranteed;
    }

    const monthlyWeeklyInput = document.getElementById('monthlyWeeklyBudgetInput');
    if (monthlyWeeklyInput && document.activeElement !== monthlyWeeklyInput) {
      monthlyWeeklyInput.value = this.state.monthlyWeeklyBudget || 0;
    }

    const totalFixedEl = document.getElementById('totalFixedExpensesText');
    if (totalFixedEl) totalFixedEl.textContent = this.formatFt(totalFixed);

    const baseFreeEl = document.getElementById('baseFreeBudgetText');
    if (baseFreeEl) baseFreeEl.textContent = this.formatFt(freeBudget);

    const baseWeeklyCalc = document.getElementById('baseWeeklyCalc');
    if (baseWeeklyCalc) baseWeeklyCalc.textContent = `≈ ${this.formatFt(weeklyFree)}/hét`;

    const list = document.getElementById('fixedExpensesList');
    if (list) {
      if (this.state.fixedExpenses.length === 0) {
        list.innerHTML = `<div class="p-4 text-center text-xs text-slate-500 bg-slate-950/40 rounded-xl border border-slate-800">Nincs rögzített fix kiadás. Adj hozzá egyet a fenti gombbal!</div>`;
      } else {
        list.innerHTML = this.state.fixedExpenses.map(item => `
          <div class="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 hover:border-slate-700 transition">
            <div class="flex items-center gap-2.5">
              <span class="w-2 h-2 rounded-full bg-rose-500"></span>
              <span class="text-xs sm:text-sm font-semibold text-slate-200">${this.escapeHtml(item.name)}</span>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-xs sm:text-sm font-bold text-rose-400">${this.formatFt(item.amount)}</span>
              <button onclick="app.deleteFixedExpense('${item.id}')" title="Törlés" class="p-1 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-900 transition">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          </div>
        `).join('');
      }
    }
  }

  renderGoalsSection() {
    const totalPercent = this.getTotalGoalsPercentage();
    const badge = document.getElementById('percentageBadge');
    if (badge) {
      if (totalPercent === 100) {
        badge.className = 'px-3 py-1.5 rounded-xl font-bold text-xs flex items-center gap-1.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        badge.innerHTML = '<span>Összes arány: 100% ✓</span>';
      } else if (totalPercent < 100) {
        badge.className = 'px-3 py-1.5 rounded-xl font-bold text-xs flex items-center gap-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/30';
        badge.innerHTML = `<span>Összes: ${totalPercent}% (Hiányzik: ${100 - totalPercent}%)</span>`;
      } else {
        badge.className = 'px-3 py-1.5 rounded-xl font-bold text-xs flex items-center gap-1.5 bg-rose-500/20 text-rose-300 border border-rose-500/30';
        badge.innerHTML = `<span>Összes: ${totalPercent}% (Túllépés: +${totalPercent - 100}%)</span>`;
      }
    }

    const container = document.getElementById('goalsContainer');
    if (container) {
      if (this.state.goals.length === 0) {
        container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500 bg-slate-950/40 rounded-xl border border-slate-800">Még nincsenek megtakarítási célok. Kattints a "+ Új Cél" gombra!</div>`;
      } else {
        container.innerHTML = this.state.goals.map(goal => {
          const target = Number(goal.target) || 1;
          const current = Number(goal.current) || 0;
          const percentDone = Math.min(100, Math.round((current / target) * 100));
          const remaining = Math.max(0, target - current);
          const isCompleted = current >= target;

          return `
            <div class="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 sm:p-4 hover:border-slate-700/80 transition relative overflow-hidden group">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-sm">
                    ${isCompleted ? '🏆' : '🎯'}
                  </span>
                  <div>
                    <h4 class="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                      ${this.escapeHtml(goal.name)}
                      ${isCompleted ? '<span class="text-[10px] bg-emerald-500 text-slate-950 px-2 py-0.5 rounded font-black">ELÉRVE!</span>' : ''}
                    </h4>
                    <span class="text-[11px] text-slate-400">
                      Elosztási súly: <strong class="text-blue-400">${goal.percent}%</strong>
                    </span>
                  </div>
                </div>

                <div class="flex items-center gap-1.5">
                  <button onclick="app.adjustGoalFunds('${goal.id}', 1)" title="Pénz hozzáadása" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-emerald-950/50 hover:text-emerald-400 text-slate-300 text-xs font-bold border border-slate-700/70 transition">
                    +Ft
                  </button>
                  <button onclick="app.adjustGoalFunds('${goal.id}', -1)" title="Pénz kivétele" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-rose-950/50 hover:text-rose-400 text-slate-300 text-xs font-bold border border-slate-700/70 transition">
                    -Ft
                  </button>
                  <button onclick="app.openEditGoalModal('${goal.id}')" title="Szerkesztés" class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                  </button>
                  <button onclick="app.deleteGoal('${goal.id}')" title="Törlés" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                  </button>
                </div>
              </div>

              <!-- Numbers Row -->
              <div class="flex items-center justify-between text-xs mb-1.5">
                <span class="text-slate-300 font-semibold">
                  <span class="text-emerald-400 font-bold">${this.formatFt(current)}</span> / ${this.formatFt(target)}
                </span>
                <span class="text-xs font-bold ${isCompleted ? 'text-emerald-400' : 'text-blue-400'}">
                  ${percentDone}%
                </span>
              </div>

              <!-- Visual Progress Bar -->
              <div class="w-full bg-slate-900 rounded-full h-3 overflow-hidden p-0.5 border border-slate-800">
                <div class="h-full rounded-full transition-all duration-500 ${isCompleted ? 'bg-gradient-to-r from-emerald-500 to-teal-400' : 'bg-gradient-to-r from-blue-500 via-indigo-500 to-emerald-400'}" style="width: ${percentDone}%"></div>
              </div>

              <div class="flex items-center justify-between text-[11px] text-slate-400 mt-1.5">
                <span>${isCompleted ? '🎉 Cél teljesítve!' : `Még hiányzik: <strong class="text-slate-300">${this.formatFt(remaining)}</strong>`}</span>
                <span class="text-slate-500">Kattints a +Ft / -Ft gombra manuális igazításhoz</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Render savings history
    const historyList = document.getElementById('savingsHistoryList');
    if (historyList) {
      const history = this.state.history || [];
      if (history.length === 0) {
        historyList.innerHTML = `<div class="p-4 text-center text-xs text-slate-500 bg-slate-950/40 rounded-xl border border-slate-800">Még nincsenek rögzített tranzakciók a történetben.</div>`;
      } else {
        historyList.innerHTML = history.map(item => `
          <div class="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80 hover:border-slate-700/80 transition text-xs flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold text-slate-200 truncate">${this.escapeHtml(item.title)}</span>
              <div class="flex items-center gap-2 shrink-0">
                <span class="font-extrabold ${item.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}">
                  ${item.amount >= 0 ? '+' : ''}${this.formatFt(item.amount)}
                </span>
                <button onclick="app.openEditHistoryModal('${item.id}')" title="Módosítás" class="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                </button>
                <button onclick="app.deleteHistoryItem('${item.id}')" title="Törlés" class="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              </div>
            </div>
            <div class="flex items-center justify-between text-[10px] text-slate-400 border-t border-slate-900/60 pt-1">
              <span class="truncate max-w-[70%]">${this.escapeHtml(item.breakdown || '')}</span>
              <span class="text-slate-500 shrink-0 ml-2">${item.date}</span>
            </div>
          </div>
        `).join('');
      }
    }
  }

  renderWeeklySection() {
    const cycle = this.getCycleInfo();
    const curWeek = this.getActiveWeek();
    const isAuto = this.state.weekMode === 'auto';

    const baseBudget = this.getBaseBudgetForWeek(curWeek);
    const weekData = this.getWeekData(curWeek);
    const rollover = Number(weekData.rollover) || 0;
    const effectiveBudget = this.getEffectiveWeeklyBudget(curWeek);
    const spent = this.getWeeklySpent(curWeek);
    const remaining = this.getWeeklyRemaining(curWeek);
    const isDeficit = remaining < 0;

    // 1. Render Pending Surpluses from any closed weeks
    const pendingContainer = document.getElementById('pendingSurplusContainer');
    if (pendingContainer) {
      const isManual = this.state.weekMode === 'manual';
      const limitWeek = isManual ? (this.state.manualWeek || 1) : cycle.autoWeek;

      const pendingWeeks = [];
      for (let w = 1; w < limitWeek; w++) {
        const wD = this.getWeekData(w);
        if (wD.surplusStatus === 'archived' || wD.surplusStatus === 'resolved') {
          continue;
        }
        const rem = this.getWeeklyRemaining(w);
        if (rem > 0) {
          pendingWeeks.push({ weekNum: w, surplus: rem });
        }
      }

      if (pendingWeeks.length === 0) {
        pendingContainer.innerHTML = '';
      } else {
        pendingContainer.innerHTML = pendingWeeks.map(p => `
          <div class="p-4 rounded-2xl bg-gradient-to-r from-amber-950/70 via-slate-900 to-emerald-950/70 border-2 border-amber-500/70 shadow-2xl space-y-3 animate-fadeIn">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-amber-500/20 pb-2.5">
              <div class="flex items-center gap-2.5">
                <span class="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center justify-center text-lg shrink-0">⏳</span>
                <div>
                  <h4 class="text-sm font-extrabold text-white flex items-center gap-2 flex-wrap">
                    <span>Az ${p.weekNum}. hét lezárult.</span>
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">Függőben lévő összeg</span>
                  </h4>
                  <span class="text-xs text-slate-300">
                    Fennmaradó összeg: <strong class="text-emerald-400 text-sm font-extrabold">${this.formatFt(p.surplus)}</strong>
                  </span>
                </div>
              </div>
              <span class="text-[11px] text-amber-300/80 font-medium">Válassz a két lehetőség közül:</span>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button onclick="app.decisionAddToNextWeek(${p.weekNum})" class="p-3 rounded-xl bg-blue-950/60 hover:bg-blue-900/70 border border-blue-500/60 text-left transition flex items-center justify-between group active:scale-[0.98]">
                <div>
                  <span class="text-xs font-bold text-blue-200 block group-hover:text-white">1. Hozzáadás a következő héthez</span>
                  <span class="text-[10px] text-blue-300/80">${p.weekNum < 4 ? `Megnöveli a(z) ${p.weekNum + 1}. hét keretét (+${this.formatFt(p.surplus)})` : 'A 4. hét az utolsó hét a ciklusban'}</span>
                </div>
                <span class="text-base shrink-0 ml-2">⏩</span>
              </button>

              <button onclick="app.openWeekDecisionModal(${p.weekNum}); app.decisionShowGoalSelection(${p.weekNum})" class="p-3 rounded-xl bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-500/60 text-left transition flex items-center justify-between group active:scale-[0.98]">
                <div>
                  <span class="text-xs font-bold text-emerald-200 block group-hover:text-white">2. Átutalás megtakarítási célhoz</span>
                  <span class="text-[10px] text-emerald-300/80">Kiválasztás a célok közül...</span>
                </div>
                <span class="text-base shrink-0 ml-2">🎯</span>
              </button>
            </div>
          </div>
        `).join('');
      }
    }

    // 2. Cycle Mode Badge and Date Range
    const cycleBadge = document.getElementById('cycleModeBadge');
    if (cycleBadge) {
      if (isAuto) {
        cycleBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-cyan-950/60 text-cyan-300 border border-cyan-800/40';
        cycleBadge.textContent = `📅 Automatikus (Mai nap: ${cycle.autoWeek}. hét)`;
      } else {
        cycleBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-950/60 text-amber-300 border border-amber-800/40';
        cycleBadge.textContent = `⚙️ Kézi felülbírálás (${curWeek}. hét)`;
      }
    }

    const titleEl = document.getElementById('currentWeekTitle');
    if (titleEl) {
      titleEl.innerHTML = `${curWeek}. Hét Kerete <span class="text-xs px-2 py-0.5 rounded-md font-bold ${isDeficit ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'}">${isDeficit ? 'Túllépés!' : 'Normál'}</span>`;
    }

    const dateRangeEl = document.getElementById('currentWeekDateRange');
    if (dateRangeEl) {
      const rangeStr = cycle.weekDateRanges[curWeek] || '';
      dateRangeEl.innerHTML = `Periódus: <strong class="text-slate-200">${rangeStr}</strong> • Ciklus: ${cycle.cycleLabel}`;
    }

    // 3. Week Selector Pills (1..4 + Auto) with dates
    const pillsContainer = document.getElementById('weekPills');
    if (pillsContainer) {
      const shortLabels = {
        1: '15–21.',
        2: '22–28.',
        3: '29–4.',
        4: '5–14.'
      };

      const autoPill = `
        <button onclick="app.setWeekMode('auto')" class="px-2.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 shrink-0 ${isAuto ? 'bg-cyan-500 text-slate-950 shadow-md font-black' : 'text-slate-400 hover:text-white hover:bg-slate-900 border border-slate-800'}" title="Automatikus naptár szerinti hét követése">
          <span>📅 Auto</span>
        </button>
      `;

      const weekPills = [1, 2, 3, 4].map(w => {
        const isActive = w === curWeek;
        const isCurrentAuto = w === cycle.autoWeek;
        const wRem = this.getWeeklyRemaining(w);
        const hasDeficit = wRem < 0;

        let cls = 'px-2.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shrink-0 ';
        if (isActive) {
          cls += hasDeficit ? 'bg-rose-600 text-white shadow-md' : 'bg-emerald-500 text-slate-950 shadow-md';
        } else {
          cls += hasDeficit ? 'text-rose-400 hover:bg-slate-900 border border-rose-900/50' : 'text-slate-400 hover:text-white hover:bg-slate-900';
        }

        return `
          <button onclick="app.selectWeekManual(${w})" class="${cls}" title="${cycle.weekDateRanges[w]}">
            <span>${w}. hét</span>
            <span class="text-[10px] opacity-80 font-normal">(${shortLabels[w]})</span>
            ${isCurrentAuto ? '<span class="w-1.5 h-1.5 rounded-full bg-cyan-400" title="Aktuális naptári hét"></span>' : ''}
            ${hasDeficit ? '<span class="w-1.5 h-1.5 rounded-full bg-rose-300 animate-ping"></span>' : ''}
          </button>
        `;
      }).join('');

      pillsContainer.innerHTML = autoPill + weekPills;
    }

    // 4. Highlight Balance Cards
    const baseEl = document.getElementById('statBaseBudget');
    if (baseEl) baseEl.textContent = this.formatFt(baseBudget);

    const baseBadge = document.getElementById('statBaseBudgetBadge');
    if (baseBadge) {
      if (weekData.customBaseBudget !== null && weekData.customBaseBudget !== undefined) {
        baseBadge.classList.remove('hidden');
        baseBadge.textContent = 'Egyedi';
      } else {
        baseBadge.classList.add('hidden');
      }
    }

    const rollEl = document.getElementById('statRollover');
    if (rollEl) {
      rollEl.textContent = (rollover > 0 ? '+' : '') + this.formatFt(rollover);
      rollEl.className = 'text-base sm:text-lg font-bold ' + (rollover < 0 ? 'text-rose-400' : rollover > 0 ? 'text-emerald-400' : 'text-slate-300');
    }

    const rollBadge = document.getElementById('statRolloverBadge');
    if (rollBadge) {
      if (weekData.hasManualRollover) {
        rollBadge.classList.remove('hidden');
        rollBadge.textContent = 'Kézi';
      } else {
        rollBadge.classList.add('hidden');
      }
    }

    const spentEl = document.getElementById('statSpent');
    if (spentEl) spentEl.textContent = this.formatFt(spent);

    const remEl = document.getElementById('statRemaining');
    const remCard = document.getElementById('statRemainingCard');
    const remBadge = document.getElementById('statRemainingBadge');
    if (remBadge) {
      if (weekData.manualRemaining !== null && weekData.manualRemaining !== undefined) {
        remBadge.classList.remove('hidden');
        remBadge.textContent = 'Kézi';
      } else {
        remBadge.classList.add('hidden');
      }
    }

    if (remEl && remCard) {
      remEl.textContent = this.formatFt(remaining);
      if (isDeficit) {
        remEl.className = 'text-base sm:text-lg font-extrabold text-rose-400';
        remCard.className = 'bg-rose-950/40 p-3 rounded-xl border border-rose-700/60 transition cursor-pointer relative group';
      } else {
        remEl.className = 'text-base sm:text-lg font-extrabold text-emerald-400';
        remCard.className = 'bg-emerald-950/30 p-3 rounded-xl border border-emerald-800/40 transition cursor-pointer relative group';
      }
    }

    // Rollover Alert Banner
    const alertBox = document.getElementById('rolloverAlert');
    const alertTitle = document.getElementById('rolloverAlertTitle');
    const alertDesc = document.getElementById('rolloverAlertDesc');
    if (alertBox) {
      if (isDeficit) {
        alertBox.classList.remove('hidden');
        if (alertTitle) alertTitle.textContent = `Túlköltekezés a(z) ${curWeek}. héten: ${this.formatFt(remaining)}!`;
        if (alertDesc) alertDesc.textContent = curWeek < 4 
          ? `Ez a ${this.formatFt(Math.abs(remaining))} hiány automatikusan levonódik a(z) ${curWeek + 1}. hét keretéből a gördülő elszámolás szabálya szerint.`
          : `A havi ciklus utolsó hetében a túlköltekezés meghaladta a havi keretet!`;
      } else {
        alertBox.classList.add('hidden');
      }
    }

    // Surplus action text in weekly summary
    const surplusText = document.getElementById('surplusText');
    if (surplusText) {
      if (remaining > 0) {
        surplusText.innerHTML = `Fennmaradó keret ezen a héten: <strong class="text-emerald-400">${this.formatFt(remaining)}</strong>. A hét végén eldöntheted, hogy átviszed a következő hétre vagy célba mented.`;
      } else {
        surplusText.textContent = `A hét lezárásakor átléphetsz a következő hétre.`;
      }
    }

    // 5. Update Manual Settings Box buttons state
    const statusText = document.getElementById('manualModeStatusText');
    if (statusText) {
      statusText.textContent = isAuto
        ? `Automatikus mód (Mai nap: ${cycle.autoWeek}. hét)`
        : `Kézi felülbírálás (${curWeek}. hét aktív)`;
      statusText.className = isAuto ? 'text-[10px] text-emerald-400 font-bold' : 'text-[10px] text-cyan-400 font-bold';
    }

    const budgetLabel = document.getElementById('customWeekBudgetLabel');
    if (budgetLabel) {
      budgetLabel.textContent = `A(z) ${curWeek}. hét induló kerete:`;
    }

    const modeAutoBtn = document.getElementById('modeBtn-auto');
    if (modeAutoBtn) {
      modeAutoBtn.className = isAuto
        ? 'py-1.5 px-2 rounded-lg text-xs font-bold transition bg-emerald-500 text-slate-950 flex items-center justify-center gap-1 shadow'
        : 'py-1.5 px-2 rounded-lg text-xs font-bold transition bg-slate-900 text-slate-400 hover:text-white border border-slate-800';
    }

    [1, 2, 3, 4].forEach(w => {
      const btn = document.getElementById(`modeBtn-${w}`);
      if (btn) {
        const isSelectedManual = !isAuto && this.state.manualWeek === w;
        btn.className = isSelectedManual
          ? 'py-1.5 px-2 rounded-lg text-xs font-bold transition bg-cyan-600 text-white shadow'
          : 'py-1.5 px-2 rounded-lg text-xs font-bold transition bg-slate-900 text-slate-400 hover:text-white border border-slate-800';
      }
    });

    const customBudgetInput = document.getElementById('customWeekBudgetInput');
    if (customBudgetInput && document.activeElement !== customBudgetInput) {
      customBudgetInput.value = weekData.customBaseBudget !== null ? weekData.customBaseBudget : baseBudget;
    }

    // 6. Expenses List
    const listEl = document.getElementById('weeklyExpenseList');
    const badgeEl = document.getElementById('expenseCountBadge');
    const expenses = weekData.expenses || [];

    if (badgeEl) badgeEl.textContent = `${expenses.length} tétel`;

    if (listEl) {
      if (expenses.length === 0) {
        listEl.innerHTML = `<div class="p-6 text-center text-xs text-slate-500 bg-slate-950/40 rounded-xl border border-slate-800">Ezen a héten még nem rögzítettél kiadást. Használd a fenti űrlapot, a blokk fotózást vagy a gyorsgombokat!</div>`;
      } else {
        listEl.innerHTML = expenses.map(exp => {
          const isFun = exp.category === 'szórakozás';
          return `
            <div class="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 hover:border-slate-700 transition">
              <div class="flex flex-col">
                <div class="flex items-center gap-1.5">
                  <span class="text-xs sm:text-sm font-semibold text-slate-200">${this.escapeHtml(exp.note)}</span>
                  <span class="text-[9px] px-1.5 py-0.5 rounded font-bold ${isFun ? 'bg-purple-950/60 text-purple-300 border border-purple-800/50' : 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'}">
                    ${isFun ? '🎭 Szórakozás' : '🛒 Hasznos'}
                  </span>
                </div>
                <span class="text-[10px] text-slate-500 mt-0.5">${exp.date}</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs sm:text-sm font-bold text-rose-400">-${this.formatFt(exp.amount)}</span>
                <button onclick="app.deleteExpense('${exp.id}')" title="Kiadás törlése" class="p-1 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-900 transition">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // ==========================================
  // SECTION 7: ELSŐ INDÍTÁS VARÁZSLÓ (ONBOARDING)
  // ==========================================
  openOnboardingWizard() {
    this.stateWizard = {
      step: 1,
      cycleStartDay: this.state.cycleStartDay || 1,
      income: this.state.guaranteedIncome || '',
      fixed: Array.isArray(this.state.fixedExpenses) && this.state.fixedExpenses.length > 0 
        ? JSON.parse(JSON.stringify(this.state.fixedExpenses)) 
        : [],
      goals: Array.isArray(this.state.goals) && this.state.goals.length > 0 
        ? JSON.parse(JSON.stringify(this.state.goals)) 
        : [],
      weeklyBudget: Math.round((this.state.monthlyWeeklyBudget || 0) / 4) || '',
      startWeek: 1
    };

    // If starting fresh with no goals, offer two clean starter goal rows with balanced 50-50%
    if (this.stateWizard.goals.length === 0) {
      this.stateWizard.goals = [
        { id: 'g-wiz-1', name: 'Biztonsági tartalék', target: 300000, current: 0, percent: 50 },
        { id: 'g-wiz-2', name: 'Célkitűzés / Megtakarítás', target: 200000, current: 0, percent: 50 }
      ];
    }

    const modal = document.getElementById('onboardingModal');
    if (!modal) return;

    this.wizardGoToStep(1);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  closeOnboardingWizard() {
    const modal = document.getElementById('onboardingModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  wizardGoToStep(stepNum) {
    // Validate leaving step 1
    if (this.stateWizard.step === 1 && stepNum > 1) {
      const incInput = document.getElementById('wizardIncomeInput');
      const incVal = parseInt(incInput?.value, 10);
      this.stateWizard.income = !isNaN(incVal) && incVal >= 0 ? incVal : 0;
    }

    // Validate leaving step 2
    if (this.stateWizard.step === 2 && stepNum > 2) {
      this.collectWizardFixedRows();
    }

    // Validate leaving step 3
    if (this.stateWizard.step === 3 && stepNum > 3) {
      this.collectWizardGoalRows();
      const totalPercent = this.stateWizard.goals.reduce((s, g) => s + (Number(g.percent) || 0), 0);
      if (this.stateWizard.goals.length === 0 || totalPercent !== 100) {
        this.showToast(`A célok százalékos összegének 100%-nak kell lennie! (Jelenleg: ${totalPercent}%)`, '⚠️');
        return;
      }
    }

    this.stateWizard.step = stepNum;

    // Show/hide step panels
    for (let s = 1; s <= 4; s++) {
      const panel = document.getElementById(`wizardStep-${s}`);
      const indicator = document.getElementById(`wizardStepIndicator-${s}`);
      if (panel) {
        if (s === stepNum) {
          panel.classList.remove('hidden');
        } else {
          panel.classList.add('hidden');
        }
      }
      if (indicator) {
        const bar = indicator.querySelector('div');
        const text = indicator.querySelector('span');
        if (s <= stepNum) {
          if (bar) bar.className = 'w-full h-1.5 rounded-full bg-emerald-500 transition-all duration-300';
          if (text) text.className = 'text-[10px] font-bold text-emerald-400 mt-1';
        } else {
          if (bar) bar.className = 'w-full h-1.5 rounded-full bg-slate-800 transition-all duration-300';
          if (text) text.className = 'text-[10px] font-bold text-slate-500 mt-1';
        }
      }
    }

    // Step setup
    if (stepNum === 1) {
      this.renderWizardStep1();
    } else if (stepNum === 2) {
      this.renderWizardStep2();
    } else if (stepNum === 3) {
      this.renderWizardStep3();
    } else if (stepNum === 4) {
      this.renderWizardStep4();
    }
  }

  setWizardCycleDay(val) {
    const customRow = document.getElementById('wizardCustomDayRow');
    const btn1 = document.getElementById('wizardDayBtn-1');
    const btn15 = document.getElementById('wizardDayBtn-15');
    const btnCustom = document.getElementById('wizardDayBtn-custom');

    const defaultBtnClass = 'py-2.5 px-2 rounded-xl text-xs font-bold border transition bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-600';
    const activeBtnClass = 'py-2.5 px-2 rounded-xl text-xs font-bold border transition bg-emerald-500 text-slate-950 border-emerald-400 shadow';

    if (btn1) btn1.className = defaultBtnClass;
    if (btn15) btn15.className = defaultBtnClass;
    if (btnCustom) btnCustom.className = defaultBtnClass;

    if (val === 1) {
      this.stateWizard.cycleStartDay = 1;
      if (btn1) btn1.className = activeBtnClass;
      if (customRow) customRow.classList.add('hidden');
    } else if (val === 15) {
      this.stateWizard.cycleStartDay = 15;
      if (btn15) btn15.className = activeBtnClass;
      if (customRow) customRow.classList.add('hidden');
    } else {
      if (btnCustom) btnCustom.className = activeBtnClass;
      if (customRow) customRow.classList.remove('hidden');
      const input = document.getElementById('wizardCustomCycleDayInput');
      this.stateWizard.cycleStartDay = parseInt(input?.value, 10) || 1;
    }
  }

  updateWizardCustomDay(val) {
    const num = Math.min(31, Math.max(1, parseInt(val, 10) || 1));
    this.stateWizard.cycleStartDay = num;
  }

  renderWizardStep1() {
    const incInput = document.getElementById('wizardIncomeInput');
    if (incInput) {
      incInput.value = this.stateWizard.income || '';
    }
    this.setWizardCycleDay(this.stateWizard.cycleStartDay === 15 ? 15 : (this.stateWizard.cycleStartDay === 1 ? 1 : 'custom'));
  }

  renderWizardStep2() {
    this.renderWizardFixedRows();
  }

  renderWizardFixedRows() {
    const list = document.getElementById('wizardFixedList');
    if (!list) return;

    if (this.stateWizard.fixed.length === 0) {
      list.innerHTML = `
        <div class="p-4 text-center text-xs text-slate-500 bg-slate-950/60 rounded-xl border border-slate-800/80">
          Még nincs megadva fix kiadás. Kattints a "+ Tétel hozzáadása" gombra a felvételhez, vagy lépj tovább, ha nincs fix kiadásod!
        </div>
      `;
    } else {
      list.innerHTML = this.stateWizard.fixed.map((item, idx) => `
        <div class="grid grid-cols-12 gap-2 items-center p-2 rounded-xl bg-slate-950/80 border border-slate-800">
          <div class="col-span-7">
            <input type="text" oninput="app.updateWizardFixedItem(${idx}, 'name', this.value)" value="${this.escapeHtml(item.name || '')}" placeholder="Tétel neve (pl. Lakbér, Számlák, Bérlet)" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500">
          </div>
          <div class="col-span-4 relative">
            <input type="number" oninput="app.updateWizardFixedItem(${idx}, 'amount', this.value)" value="${item.amount || ''}" placeholder="Összeg" min="0" step="500" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-rose-300 font-bold focus:outline-none focus:border-emerald-500">
            <span class="absolute right-2 top-1.5 text-[10px] text-slate-500 font-semibold">Ft</span>
          </div>
          <div class="col-span-1 text-center">
            <button type="button" onclick="app.removeWizardFixedRow(${idx})" class="text-slate-500 hover:text-rose-400 text-sm font-bold p-1">✕</button>
          </div>
        </div>
      `).join('');
    }

    this.updateWizardStep2Totals();
  }

  addWizardFixedRow() {
    this.stateWizard.fixed.push({ id: 'fix-wiz-' + Date.now(), name: '', amount: '' });
    this.renderWizardFixedRows();
  }

  removeWizardFixedRow(idx) {
    this.stateWizard.fixed.splice(idx, 1);
    this.renderWizardFixedRows();
  }

  updateWizardFixedItem(idx, field, val) {
    if (!this.stateWizard.fixed[idx]) return;
    if (field === 'amount') {
      this.stateWizard.fixed[idx].amount = parseInt(val, 10) || 0;
    } else {
      this.stateWizard.fixed[idx].name = val;
    }
    this.updateWizardStep2Totals();
  }

  collectWizardFixedRows() {
    this.stateWizard.fixed = this.stateWizard.fixed.filter(f => f.name && f.name.trim() !== '');
  }

  updateWizardStep2Totals() {
    const totalFixed = this.stateWizard.fixed.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const free = Math.max(0, (Number(this.stateWizard.income) || 0) - totalFixed);

    const totalEl = document.getElementById('wizardTotalFixed');
    if (totalEl) totalEl.textContent = this.formatFt(totalFixed);

    const freeEl = document.getElementById('wizardFreeBudgetStep2');
    if (freeEl) freeEl.textContent = this.formatFt(free);
  }

  renderWizardStep3() {
    this.renderWizardGoalsRows();
  }

  renderWizardGoalsRows() {
    const list = document.getElementById('wizardGoalsList');
    if (!list) return;

    if (this.stateWizard.goals.length === 0) {
      list.innerHTML = `
        <div class="p-4 text-center text-xs text-slate-500 bg-slate-950/60 rounded-xl border border-slate-800/80">
          Nincs megadva megtakarítási cél. Kattints a "+ Új cél" gombra!
        </div>
      `;
    } else {
      list.innerHTML = this.stateWizard.goals.map((g, idx) => `
        <div class="grid grid-cols-12 gap-1.5 items-center p-2 rounded-xl bg-slate-950/80 border border-slate-800">
          <div class="col-span-5">
            <input type="text" oninput="app.updateWizardGoalItem(${idx}, 'name', this.value)" value="${this.escapeHtml(g.name || '')}" placeholder="pl. Biztonsági tartalék, Utazás" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
          </div>
          <div class="col-span-4 relative">
            <input type="number" oninput="app.updateWizardGoalItem(${idx}, 'target', this.value)" value="${g.target || ''}" placeholder="Célösszeg" min="1000" step="5000" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-blue-300 font-bold focus:outline-none focus:border-blue-500">
            <span class="absolute right-1.5 top-1.5 text-[9px] text-slate-500 font-semibold">Ft</span>
          </div>
          <div class="col-span-2 relative">
            <input type="number" oninput="app.updateWizardGoalItem(${idx}, 'percent', this.value)" value="${g.percent}" placeholder="%" min="0" max="100" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-1.5 py-1.5 text-center text-xs text-emerald-400 font-bold focus:outline-none focus:border-emerald-500">
            <span class="absolute right-1 top-1.5 text-[9px] text-slate-500 font-semibold">%</span>
          </div>
          <div class="col-span-1 text-center">
            <button type="button" onclick="app.removeWizardGoalRow(${idx})" class="text-slate-500 hover:text-rose-400 text-sm font-bold p-1">✕</button>
          </div>
        </div>
      `).join('');
    }

    this.updateWizardStep3Totals();
  }

  addWizardGoalRow() {
    const currentTotal = this.stateWizard.goals.reduce((s, g) => s + (Number(g.percent) || 0), 0);
    const suggested = Math.max(0, 100 - currentTotal);
    this.stateWizard.goals.push({
      id: 'g-wiz-' + Date.now(),
      name: '',
      target: 200000,
      current: 0,
      percent: suggested
    });
    this.renderWizardGoalsRows();
  }

  removeWizardGoalRow(idx) {
    this.stateWizard.goals.splice(idx, 1);
    this.renderWizardGoalsRows();
  }

  updateWizardGoalItem(idx, field, val) {
    if (!this.stateWizard.goals[idx]) return;
    if (field === 'percent') {
      this.stateWizard.goals[idx].percent = Math.min(100, Math.max(0, parseInt(val, 10) || 0));
    } else if (field === 'target') {
      this.stateWizard.goals[idx].target = Math.max(0, parseInt(val, 10) || 0);
    } else {
      this.stateWizard.goals[idx].name = val;
    }
    this.updateWizardStep3Totals();
  }

  balanceWizardGoalPercents() {
    const len = this.stateWizard.goals.length;
    if (len === 0) return;
    const base = Math.floor(100 / len);
    const remainder = 100 - (base * len);
    this.stateWizard.goals.forEach((g, idx) => {
      g.percent = base + (idx === 0 ? remainder : 0);
    });
    this.renderWizardGoalsRows();
    this.showToast('Arányok egyenlően elosztva (100%)', '⚖️');
  }

  collectWizardGoalRows() {
    this.stateWizard.goals = this.stateWizard.goals.filter(g => g.name && g.name.trim() !== '');
  }

  updateWizardStep3Totals() {
    const totalPercent = this.stateWizard.goals.reduce((s, g) => s + (Number(g.percent) || 0), 0);
    const badge = document.getElementById('wizardTotalPercentBadge');
    const toStep4Btn = document.getElementById('wizardToStep4Btn');

    if (badge) {
      if (totalPercent === 100) {
        badge.className = 'font-black px-2.5 py-1 rounded-lg bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 text-xs';
        badge.textContent = '100% ✅';
      } else if (totalPercent < 100) {
        badge.className = 'font-black px-2.5 py-1 rounded-lg bg-amber-950/60 text-amber-300 border border-amber-800/40 text-xs';
        badge.textContent = `${totalPercent}% (Hiányzik: ${100 - totalPercent}%) ⚠️`;
      } else {
        badge.className = 'font-black px-2.5 py-1 rounded-lg bg-rose-950/60 text-rose-300 border border-rose-800/40 text-xs';
        badge.textContent = `${totalPercent}% (Túllépés: +${totalPercent - 100}%) ⚠️`;
      }
    }

    if (toStep4Btn) {
      if (totalPercent === 100 && this.stateWizard.goals.length > 0) {
        toStep4Btn.classList.remove('opacity-50', 'pointer-events-none');
      } else {
        toStep4Btn.classList.add('opacity-50');
      }
    }
  }

  renderWizardStep4() {
    const totalFixed = this.stateWizard.fixed.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const free = Math.max(0, (Number(this.stateWizard.income) || 0) - totalFixed);
    const weeklyFree = Math.round(free / 4);

    const freeMonthEl = document.getElementById('wizardFreeMonthlyCalc');
    if (freeMonthEl) freeMonthEl.textContent = this.formatFt(free);

    const suggestedEl = document.getElementById('wizardSuggestedWeeklyCalc');
    if (suggestedEl) suggestedEl.textContent = `${this.formatFt(weeklyFree)} / hét`;

    const budgetInput = document.getElementById('wizardWeeklyBudgetInput');
    if (budgetInput && !budgetInput.value) {
      budgetInput.value = weeklyFree > 0 ? weeklyFree : 15000;
    }

    this.setWizardStartWeek(this.stateWizard.startWeek || 1);
  }

  applyWizardSuggestedBudget() {
    const totalFixed = this.stateWizard.fixed.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const free = Math.max(0, (Number(this.stateWizard.income) || 0) - totalFixed);
    const weeklyFree = Math.round(free / 4);
    const budgetInput = document.getElementById('wizardWeeklyBudgetInput');
    if (budgetInput) {
      budgetInput.value = weeklyFree;
    }
    this.showToast(`Javasolt heti keret alkalmazva: ${this.formatFt(weeklyFree)}`, '✨');
  }

  setWizardStartWeek(wNum) {
    this.stateWizard.startWeek = wNum;
    for (let w = 1; w <= 4; w++) {
      const btn = document.getElementById(`wizardWeekBtn-${w}`);
      if (btn) {
        if (w === wNum) {
          btn.className = 'py-2 rounded-lg text-xs font-bold transition bg-emerald-500 text-slate-950 border border-emerald-400 shadow';
        } else {
          btn.className = 'py-2 rounded-lg text-xs font-bold transition bg-slate-800 text-slate-300 border border-slate-700';
        }
      }
    }
  }

  saveAndFinishWizard() {
    const budgetInput = document.getElementById('wizardWeeklyBudgetInput');
    const weeklyBudget = parseInt(budgetInput?.value, 10);
    const validWeeklyBudget = !isNaN(weeklyBudget) && weeklyBudget > 0 ? weeklyBudget : 15000;

    this.collectWizardFixedRows();
    this.collectWizardGoalRows();

    const startWeek = this.stateWizard.startWeek || 1;

    // Apply to state
    this.state.profileSetupDone = true;
    this.state.cycleStartDay = this.stateWizard.cycleStartDay || 1;
    this.state.guaranteedIncome = Number(this.stateWizard.income) || 0;
    this.state.fixedExpenses = this.stateWizard.fixed.map((f, i) => ({
      id: f.id || `fix-${Date.now()}-${i}`,
      name: f.name.trim(),
      amount: Number(f.amount) || 0
    }));

    this.state.goals = this.stateWizard.goals.map((g, i) => ({
      id: g.id || `goal-${Date.now()}-${i}`,
      name: g.name.trim(),
      target: Number(g.target) || 100000,
      current: Number(g.current) || 0,
      percent: Number(g.percent) || 0
    }));

    this.state.monthlyWeeklyBudget = validWeeklyBudget * 4;

    // Initialize weeks cleanly
    for (let w = 1; w <= 4; w++) {
      if (w < startWeek) {
        // Earlier weeks closed/archived with 0 rollover
        this.state.weeks[w] = {
          rollover: 0,
          hasManualRollover: false,
          customBaseBudget: validWeeklyBudget,
          manualRemaining: null,
          transferredOut: 0,
          transferredToNextWeek: 0,
          expenses: [],
          surplusStatus: 'archived'
        };
      } else if (w === startWeek) {
        // Starting week clean
        this.state.weeks[w] = {
          rollover: 0,
          hasManualRollover: false,
          customBaseBudget: validWeeklyBudget,
          manualRemaining: null,
          transferredOut: 0,
          transferredToNextWeek: 0,
          expenses: [],
          surplusStatus: 'none'
        };
      } else {
        // Future weeks
        this.state.weeks[w] = {
          rollover: 0,
          hasManualRollover: false,
          customBaseBudget: validWeeklyBudget,
          manualRemaining: null,
          transferredOut: 0,
          transferredToNextWeek: 0,
          expenses: [],
          surplusStatus: 'none'
        };
      }
    }

    if (startWeek > 1) {
      this.state.weekMode = 'manual';
      this.state.manualWeek = startWeek;
      this.viewWeek = startWeek;
    } else {
      this.state.weekMode = 'auto';
      this.state.manualWeek = null;
      this.viewWeek = 1;
    }

    this.closeOnboardingWizard();
    this.updateRolloversChain();
    this.saveState();
    this.showToast('Üdvözlünk! A pénzügyi terved sikeresen elkészült. 🚀', '🎉');
  }

  // ==========================================
  // SECTION 8: BEÁLLÍTÁSOK MENÜ & ALKALMAZÁS NULLÁZÁSA
  // ==========================================
  openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;

    // Populate budget tab
    const incInput = document.getElementById('settingsGuaranteedIncome');
    if (incInput) incInput.value = this.state.guaranteedIncome || 0;

    const weeklyInput = document.getElementById('settingsWeeklyBudget');
    if (weeklyInput) weeklyInput.value = Math.round((this.state.monthlyWeeklyBudget || 0) / 4);

    this.setSettingsCycleDay(this.state.cycleStartDay === 15 ? 15 : (this.state.cycleStartDay === 1 ? 1 : 'custom'));

    this.renderSettingsFixedRows();
    this.renderSettingsGoalsRows();
    this.renderSettingsQuickButtonsList();

    this.switchSettingsTab('budget');

    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  switchSettingsTab(tab) {
    this.currentSettingsTab = tab;
    const tabs = ['budget', 'fixed', 'goals', 'quick'];
    tabs.forEach(t => {
      const btn = document.getElementById(`settingsTabBtn-${t}`);
      const panel = document.getElementById(`settingsPanel-${t}`);
      if (btn) {
        if (t === tab) {
          btn.className = 'py-1.5 px-1 rounded-lg bg-emerald-500 text-slate-950 text-center transition';
        } else {
          btn.className = 'py-1.5 px-1 rounded-lg text-slate-400 hover:text-white text-center transition';
        }
      }
      if (panel) {
        if (t === tab) {
          panel.classList.remove('hidden');
        } else {
          panel.classList.add('hidden');
        }
      }
    });
  }

  setSettingsCycleDay(val) {
    const btn1 = document.getElementById('settingsCycleBtn-1');
    const btn15 = document.getElementById('settingsCycleBtn-15');
    const btnCustom = document.getElementById('settingsCycleBtn-custom');
    const customRow = document.getElementById('settingsCustomDayRow');

    const defaultBtnClass = 'py-2 px-2 rounded-xl text-xs font-bold border transition bg-slate-800 text-slate-300 border-slate-700';
    const activeBtnClass = 'py-2 px-2 rounded-xl text-xs font-bold border transition bg-emerald-500 text-slate-950 border-emerald-400';

    if (btn1) btn1.className = defaultBtnClass;
    if (btn15) btn15.className = defaultBtnClass;
    if (btnCustom) btnCustom.className = defaultBtnClass;

    if (val === 1) {
      this.state.cycleStartDay = 1;
      if (btn1) btn1.className = activeBtnClass;
      if (customRow) customRow.classList.add('hidden');
    } else if (val === 15) {
      this.state.cycleStartDay = 15;
      if (btn15) btn15.className = activeBtnClass;
      if (customRow) customRow.classList.add('hidden');
    } else {
      if (btnCustom) btnCustom.className = activeBtnClass;
      if (customRow) customRow.classList.remove('hidden');
      const input = document.getElementById('settingsCustomDayInput');
      if (input) input.value = this.state.cycleStartDay || 10;
    }
  }

  syncSettingsBudgetWithFree() {
    const totalFixed = this.getTotalFixedExpenses();
    const incInput = document.getElementById('settingsGuaranteedIncome');
    const inc = parseInt(incInput?.value, 10) || this.state.guaranteedIncome;
    const free = Math.max(0, inc - totalFixed);
    const weeklyFree = Math.round(free / 4);

    const weeklyInput = document.getElementById('settingsWeeklyBudget');
    if (weeklyInput) weeklyInput.value = weeklyFree;
    this.showToast(`Keret kitöltve: ${this.formatFt(weeklyFree)} / hét`, '✨');
  }

  saveSettingsBudget() {
    const incInput = document.getElementById('settingsGuaranteedIncome');
    const weeklyInput = document.getElementById('settingsWeeklyBudget');

    const incVal = parseInt(incInput?.value, 10);
    const weeklyVal = parseInt(weeklyInput?.value, 10);

    const customDayInput = document.getElementById('settingsCustomDayInput');
    const isCustom = !document.getElementById('settingsCustomDayRow')?.classList.contains('hidden');
    if (isCustom && customDayInput) {
      this.state.cycleStartDay = Math.min(31, Math.max(1, parseInt(customDayInput.value, 10) || 1));
    }

    if (!isNaN(incVal) && incVal >= 0) {
      this.state.guaranteedIncome = incVal;
    }
    if (!isNaN(weeklyVal) && weeklyVal > 0) {
      this.state.monthlyWeeklyBudget = weeklyVal * 4;
      for (let w = 1; w <= 4; w++) {
        if (!this.state.weeks[w].customBaseBudget) {
          this.state.weeks[w].customBaseBudget = weeklyVal;
        }
      }
    }

    this.updateRolloversChain();
    this.saveState();
    this.showToast('Havi költségvetési beállítások mentve!', '💾');
  }

  renderSettingsFixedRows() {
    const list = document.getElementById('settingsFixedList');
    if (!list) return;

    if (this.state.fixedExpenses.length === 0) {
      list.innerHTML = `<div class="p-3 text-center text-xs text-slate-500 bg-slate-950 rounded-xl border border-slate-800">Nincsenek rögzített fix kiadások. Kattints a "+ Tétel" gombra!</div>`;
      return;
    }

    list.innerHTML = this.state.fixedExpenses.map((f, idx) => `
      <div class="grid grid-cols-12 gap-2 items-center p-2 rounded-xl bg-slate-950 border border-slate-800">
        <div class="col-span-7">
          <input type="text" id="settingsFixedName-${idx}" value="${this.escapeHtml(f.name)}" placeholder="Tétel neve" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500">
        </div>
        <div class="col-span-4 relative">
          <input type="number" id="settingsFixedAmount-${idx}" value="${f.amount}" placeholder="Összeg" min="0" step="500" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-rose-300 font-bold focus:outline-none focus:border-emerald-500">
          <span class="absolute right-1.5 top-1.5 text-[10px] text-slate-500 font-semibold">Ft</span>
        </div>
        <div class="col-span-1 text-center">
          <button type="button" onclick="app.removeSettingsFixedRow(${idx})" class="text-slate-500 hover:text-rose-400 text-sm font-bold p-1">✕</button>
        </div>
      </div>
    `).join('');
  }

  addSettingsFixedRow() {
    this.state.fixedExpenses.push({ id: 'fix-' + Date.now(), name: 'Új tétel', amount: 5000 });
    this.renderSettingsFixedRows();
  }

  removeSettingsFixedRow(idx) {
    this.state.fixedExpenses.splice(idx, 1);
    this.renderSettingsFixedRows();
  }

  saveSettingsFixed() {
    const updated = [];
    this.state.fixedExpenses.forEach((_, idx) => {
      const name = document.getElementById(`settingsFixedName-${idx}`)?.value.trim() || '';
      const amount = parseInt(document.getElementById(`settingsFixedAmount-${idx}`)?.value, 10) || 0;
      if (name) {
        updated.push({
          id: this.state.fixedExpenses[idx]?.id || 'fix-' + Date.now() + '-' + idx,
          name,
          amount
        });
      }
    });

    this.state.fixedExpenses = updated;
    this.saveState();
    this.showToast('Fix kiadások sikeresen mentve!', '💾');
  }

  renderSettingsGoalsRows() {
    const list = document.getElementById('settingsGoalsList');
    if (!list) return;

    if (this.state.goals.length === 0) {
      list.innerHTML = `<div class="p-3 text-center text-xs text-slate-500 bg-slate-950 rounded-xl border border-slate-800">Nincsenek rögzített megtakarítási célok. Kattints a "+ Új cél" gombra!</div>`;
      this.updateSettingsGoalTotal();
      return;
    }

    list.innerHTML = this.state.goals.map((g, idx) => `
      <div class="grid grid-cols-12 gap-1.5 items-center p-2 rounded-xl bg-slate-950 border border-slate-800">
        <div class="col-span-5">
          <input type="text" id="settingsGoalName-${idx}" oninput="app.updateSettingsGoalTotal()" value="${this.escapeHtml(g.name)}" placeholder="Cél neve" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
        </div>
        <div class="col-span-4 relative">
          <input type="number" id="settingsGoalTarget-${idx}" value="${g.target}" placeholder="Célösszeg" min="1000" step="5000" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-blue-300 font-bold focus:outline-none focus:border-blue-500">
          <span class="absolute right-1.5 top-1.5 text-[9px] text-slate-500 font-semibold">Ft</span>
        </div>
        <div class="col-span-2 relative">
          <input type="number" id="settingsGoalPercent-${idx}" oninput="app.updateSettingsGoalTotal()" value="${g.percent}" placeholder="%" min="0" max="100" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-1.5 py-1.5 text-center text-xs text-emerald-400 font-bold focus:outline-none focus:border-emerald-500">
          <span class="absolute right-1 top-1.5 text-[9px] text-slate-500 font-semibold">%</span>
        </div>
        <div class="col-span-1 text-center">
          <button type="button" onclick="app.removeSettingsGoalRow(${idx})" class="text-slate-500 hover:text-rose-400 text-sm font-bold p-1">✕</button>
        </div>
      </div>
    `).join('');

    this.updateSettingsGoalTotal();
  }

  addSettingsGoalRow() {
    this.state.goals.push({ id: 'goal-' + Date.now(), name: 'Új cél', target: 150000, current: 0, percent: 0 });
    this.renderSettingsGoalsRows();
  }

  removeSettingsGoalRow(idx) {
    this.state.goals.splice(idx, 1);
    this.renderSettingsGoalsRows();
  }

  balanceSettingsGoalPercents() {
    const len = this.state.goals.length;
    if (len === 0) return;
    const base = Math.floor(100 / len);
    const remainder = 100 - (base * len);
    this.state.goals.forEach((_, idx) => {
      const input = document.getElementById(`settingsGoalPercent-${idx}`);
      if (input) {
        input.value = base + (idx === 0 ? remainder : 0);
      }
    });
    this.updateSettingsGoalTotal();
    this.showToast('Arányok kiegyenlítve!', '⚖️');
  }

  updateSettingsGoalTotal() {
    let total = 0;
    this.state.goals.forEach((_, idx) => {
      const val = parseInt(document.getElementById(`settingsGoalPercent-${idx}`)?.value, 10) || 0;
      total += val;
    });

    const badge = document.getElementById('settingsGoalPercentTotal');
    if (badge) {
      if (total === 100) {
        badge.className = 'font-bold text-emerald-400';
        badge.textContent = '100% ✅';
      } else if (total < 100) {
        badge.className = 'font-bold text-amber-300';
        badge.textContent = `${total}% (Hiányzik: ${100 - total}%) ⚠️`;
      } else {
        badge.className = 'font-bold text-rose-300';
        badge.textContent = `${total}% (Túllépés: +${total - 100}%) ⚠️`;
      }
    }
  }

  saveSettingsGoals() {
    const updated = [];
    let totalPercent = 0;

    this.state.goals.forEach((g, idx) => {
      const name = document.getElementById(`settingsGoalName-${idx}`)?.value.trim() || '';
      const target = parseInt(document.getElementById(`settingsGoalTarget-${idx}`)?.value, 10) || 100000;
      const percent = parseInt(document.getElementById(`settingsGoalPercent-${idx}`)?.value, 10) || 0;

      if (name) {
        totalPercent += percent;
        updated.push({
          id: g.id || 'goal-' + Date.now() + '-' + idx,
          name,
          target,
          current: g.current || 0,
          percent
        });
      }
    });

    if (updated.length > 0 && totalPercent !== 100) {
      this.showToast(`Az arányok összegének 100%-nak kell lennie! (Jelenleg: ${totalPercent}%)`, '⚠️');
      return;
    }

    this.state.goals = updated;
    this.saveState();
    this.updateDistributePreview();
    this.showToast('Megtakarítási célok elmentve!', '💾');
  }

  renderSettingsQuickButtonsList() {
    const container = document.getElementById('settingsQuickButtonsList');
    if (!container) return;

    const buttons = this.state.quickButtons || [];
    container.innerHTML = buttons.map((b) => `
      <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800">
        <div class="flex items-center gap-2">
          <span class="text-base">${b.icon || '⚡'}</span>
          <div>
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-bold text-white">${this.escapeHtml(b.label)}</span>
              <span class="text-[9px] px-1 rounded font-semibold ${b.type === 'expense' ? 'bg-rose-950/60 text-rose-300' : 'bg-emerald-950/60 text-emerald-300'}">
                ${b.type === 'expense' ? 'Kiadás' : 'Bevétel'}
              </span>
            </div>
            <span class="text-xs font-extrabold ${b.type === 'expense' ? 'text-rose-400' : 'text-emerald-400'}">
              ${b.type === 'expense' ? '-' : '+'}${this.formatFt(b.amount)}
            </span>
          </div>
        </div>
        <button type="button" onclick="app.closeSettingsModal(); app.editQuickButton('${b.id}')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300">
          Szerkesztés
        </button>
      </div>
    `).join('');
  }

  confirmResetAppEntirely() {
    this.askConfirm(
      'Alkalmazás teljes nullázása',
      'Biztosan törölni szeretnéd az összes rögzített adatot, tranzakciót és egyenleget? Ezzel újraindul a kezdeti beállító varázsló.',
      () => {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch (e) {}

        this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
        this.closeSettingsModal();
        this.openOnboardingWizard();
        this.render();
        this.showToast('Alkalmazás nullázva! Kezdő varázsló elindítva.', '🔄');
      }
    );
  }
}

// Global instance exposed for inline onclick handlers
window.app = new BudgetApp();
