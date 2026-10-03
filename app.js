/**
 * Matematika Gyakorló Portál - Dinamikus Kártya Megjelenítő és Eseménykezelő
 */

document.addEventListener('DOMContentLoaded', () => {
    // Auth State (managed on Server via HTTP-only Cookies)
    let isLoggedIn = false;
    let userRole = null; // 'admin' or 'student'
    let TASKS_DATA = [];

    // Environment detection: use local Express Node server routes vs PHP production server routes
    const isLocalNode = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port === '3000';

    function getApiUrl(action) {
        if (isLocalNode) {
            return `/api/${action}`;
        } else {
            return `api.php?action=${action}`;
        }
    }
    let taskStatuses = {}; // Stored progress statuses: { S145: 'kesz' | 'atnezendo' }
    let taskLessons = {};  // Stored lesson assignments: { S145: 1 | 2 | ... | 20 }

    const sidebar = document.getElementById('app-sidebar');
    const sidebarNav = document.getElementById('sidebar-nav');
    const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
    const sidebarOpenBtn = document.getElementById('sidebar-open-btn');
    const searchInput = document.getElementById('erettsegi-search-input');
    
    const activeTaskContainer = document.getElementById('active-task-container');
    const prevTaskBtn = document.getElementById('btn-task-prev');
    const nextTaskBtn = document.getElementById('btn-task-next');

    // Sidebar view mode toggles
    const btnViewCategories = document.getElementById('btn-view-categories');
    const btnViewLessons = document.getElementById('btn-view-lessons');
    let sidebarListMode = 'categories'; // 'categories' or 'lessons'

    // Login UI Elements
    const btnLoginHeader = document.getElementById('btn-login-header');
    const loginModal = document.getElementById('login-modal-overlay');
    const loginModalClose = document.getElementById('login-modal-close');
    const loginForm = document.getElementById('login-modal-form');
    const loginUsernameInput = document.getElementById('login-username');
    const loginPasswordInput = document.getElementById('login-password');
    const loginErrorMsg = document.getElementById('login-error-msg');

    // App State
    let activeTaskId = null;
    let openCategories = new Set();
    let currentTasksList = []; // Tasks matching current search query
    
    // Stepper states for each task: { taskId: { currentStep: 0, showAll: false, theoryExpanded: false, statementExpanded: true, stepperExpanded: false } }
    const stepperStates = {};

    // Group tasks by category
    function getCategoriesData() {
        const categories = {};
        currentTasksList.forEach(task => {
            if (!categories[task.category]) {
                categories[task.category] = {
                    name: task.categoryName,
                    id: task.category,
                    tasks: []
                };
            }
            categories[task.category].tasks.push(task);
        });
        return Object.values(categories);
    }

    // Group tasks by assigned lesson (1-20, plus unassigned)
    function getLessonsData() {
        const lessons = {};
        
        // Initialize all 20 lessons (always visible)
        for (let i = 1; i <= 20; i++) {
            lessons[i] = {
                name: `${i}. Óra`,
                id: `lesson-${i}`,
                tasks: []
            };
        }
        
        // Unassigned group (only visible to admin)
        if (isLoggedIn && userRole === 'admin') {
            lessons['unassigned'] = {
                name: 'Nincs bekategorizálva',
                id: 'lesson-unassigned',
                tasks: []
            };
        }

        currentTasksList.forEach(task => {
            const assignedLesson = taskLessons[task.id];
            if (assignedLesson && lessons[assignedLesson]) {
                lessons[assignedLesson].tasks.push(task);
            } else if (isLoggedIn && userRole === 'admin' && lessons['unassigned']) {
                // Only show unassigned tasks to logged-in admin
                lessons['unassigned'].tasks.push(task);
            }
        });

        // Do not filter out empty lessons: show all 1-20 and unassigned (if admin)
        return Object.values(lessons);
    }

    // Check if a task is locked for the current session
    function isTaskLocked(task) {
        if (isLoggedIn) return false;
        
        // Find index of task in its original category list
        if (typeof TASKS_DATA === 'undefined') return false;
        const catTasks = TASKS_DATA.filter(t => t.category === task.category);
        const idx = catTasks.findIndex(t => t.id === task.id);
        
        return idx >= 3; // Lock all tasks starting from index 3 (4th task onwards)
    }

    // Clean and format task title dynamically based on category index and login state
    function getTaskDisplayTitle(task) {
        if (!task) return '';
        
        // Remove leading hardcoded digits (e.g. "145. ")
        const cleanTitle = task.title.replace(/^\d+\.\s*/, '');
        
        // Safeguard if TASKS_DATA is not loaded yet
        if (typeof TASKS_DATA === 'undefined' || TASKS_DATA.length === 0) {
            return cleanTitle;
        }
        
        // Find 1-based index within its math category
        const catTasks = TASKS_DATA.filter(t => t.category === task.category);
        const index = catTasks.findIndex(t => t.id === task.id) + 1;
        
        if (isLoggedIn && userRole === 'admin') {
            return `${index}. [${task.id}] ${cleanTitle}`;
        } else {
            return `${index}. ${cleanTitle}`;
        }
    }

    // Load dynamic data from Node Server API
    async function loadDataFromServer() {
        try {
            // 1. Fetch masked/unmasked tasks depending on login session
            const res = await fetch(getApiUrl('tasks'));
            const contentType = res.headers.get("content-type");
            if (!res.ok || !contentType || !contentType.includes("application/json")) {
                throw new Error("Invalid tasks response from server (make sure server is running and updated)");
            }
            
            const data = await res.json();
            isLoggedIn = data.isLoggedIn;
            userRole = data.role || null;
            TASKS_DATA = data.tasks;
            currentTasksList = [...TASKS_DATA];

            // 2. Fetch progress statuses if authenticated
            taskStatuses = {};
            if (isLoggedIn) {
                try {
                    const statusRes = await fetch(getApiUrl('status'));
                    const statusType = statusRes.headers.get("content-type");
                    if (statusRes.ok && statusType && statusType.includes("application/json")) {
                        taskStatuses = await statusRes.json();
                    }
                } catch (statusErr) {
                    console.warn("Failed to fetch progress status:", statusErr);
                }
            }

            // 3. Fetch lesson assignments (accessible to anyone to construct sidebar)
            taskLessons = {};
            try {
                const lessonRes = await fetch(getApiUrl('lessons'));
                const lessonType = lessonRes.headers.get("content-type");
                if (lessonRes.ok && lessonType && lessonType.includes("application/json")) {
                    taskLessons = await lessonRes.json();
                }
            } catch (lessonErr) {
                console.warn("Failed to fetch lesson assignments:", lessonErr);
            }

            // 4. Initialize state tracking map for new tasks
            TASKS_DATA.forEach(task => {
                if (!stepperStates[task.id]) {
                    stepperStates[task.id] = {
                        currentStep: 0,
                        showAll: false,
                        theoryExpanded: false,
                        statementExpanded: true,
                        stepperExpanded: false
                    };
                }
            });

            // Set active task to first one if none selected or if active one no longer exists
            if (TASKS_DATA.length > 0) {
                const stillExists = TASKS_DATA.some(t => t.id === activeTaskId);
                if (!stillExists) {
                    activeTaskId = TASKS_DATA[0].id;
                    // Auto-open active category or lesson in sidebar
                    if (sidebarListMode === 'categories') {
                        openCategories.add(TASKS_DATA[0].category);
                    } else {
                        const activeLesson = taskLessons[TASKS_DATA[0].id] || 'unassigned';
                        openCategories.add(`lesson-${activeLesson}`);
                    }
                }
            }

            updateHeaderAuthUI();
            renderSidebar();
            renderActiveTask();
            updateNavigationButtons();

        } catch (err) {
            console.error('Failed to communicate with server API:', err);
            // Render a fallback UI message if task loading completely failed
            if (activeTaskContainer) {
                activeTaskContainer.innerHTML = `
                    <div class="info-card" style="text-align: center; padding: 3rem; border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.02);">
                        <h4 style="color: #ef4444; margin-bottom: 1rem;">Kapcsolódási hiba</h4>
                        <p style="color: var(--text-muted); font-size: 0.9rem;">Nem sikerült betölteni a feladatokat a szerverről.</p>
                        <p style="color: #f43f5e; font-size: 0.8rem; margin-top: 1rem; font-weight: 600;">Figyelem: Kérjük indítsd újra a Node szervert a terminálban (Ctrl + C, majd "node server.js")!</p>
                    </div>
                `;
            }
        }
    }

    // Update login/logout button UI in the header
    function updateHeaderAuthUI() {
        if (!btnLoginHeader) return;
        if (isLoggedIn) {
            btnLoginHeader.classList.add('logged-in');
            if (userRole === 'admin') {
                btnLoginHeader.innerHTML = 'Kijelentkezés (admin)';
            } else {
                btnLoginHeader.innerHTML = 'Kijelentkezés (diák)';
            }
        } else {
            btnLoginHeader.classList.remove('logged-in');
            btnLoginHeader.innerHTML = 'Bejelentkezés';
        }
    }

    // Select and load a task
    function selectTask(taskId) {
        activeTaskId = taskId;
        
        // Reset/init states for this task when newly opened
        if (stepperStates[taskId]) {
            stepperStates[taskId].theoryExpanded = false;
            stepperStates[taskId].statementExpanded = true;
            stepperStates[taskId].stepperExpanded = false;
        }

        renderActiveTask();
        renderSidebar(); // Update active highlights
        updateNavigationButtons();
    }

    // Update bottom footer navigation buttons
    function updateNavigationButtons() {
        const activeIndex = currentTasksList.findIndex(t => t.id === activeTaskId);
        if (activeIndex === -1) {
            prevTaskBtn.disabled = true;
            nextTaskBtn.disabled = true;
            return;
        }

        prevTaskBtn.disabled = activeIndex === 0;
        nextTaskBtn.disabled = activeIndex === currentTasksList.length - 1;
    }

    // Render the left sidebar accordions and search
    function renderSidebar() {
        if (!sidebarNav) return;

        // Group tasks by category or by lesson based on active view mode
        const groups = (sidebarListMode === 'categories') ? getCategoriesData() : getLessonsData();

        if (groups.length === 0) {
            sidebarNav.innerHTML = `<div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                Nincs találat
            </div>`;
            return;
        }

        sidebarNav.innerHTML = groups.map(group => {
            const isOpen = openCategories.has(group.id);
            const tasksHtml = group.tasks.map(task => {
                const isActive = task.id === activeTaskId;
                
                // Highlight unassigned tasks with red border for ADMIN only
                const isUnassignedAdmin = isLoggedIn && userRole === 'admin' && (!taskLessons[task.id]);
                const unassignedClass = isUnassignedAdmin ? 'unassigned-admin' : '';
                
                // Lock icon or status dot
                let statusIndicator = '';
                if (task.isLocked) {
                    statusIndicator = `<span class="sidebar-lock-badge">🔒</span>`;
                } else if (isLoggedIn && taskStatuses[task.id]) {
                    const status = taskStatuses[task.id];
                    statusIndicator = `<span class="sidebar-status-dot ${status}"></span>`;
                }

                return `
                    <button class="sidebar-task-link ${isActive ? 'active' : ''} ${unassignedClass}" data-task-id="${task.id}">
                        <div class="sidebar-task-text-group">
                            <span>${getTaskDisplayTitle(task)}</span>
                        </div>
                        ${statusIndicator}
                    </button>
                `;
            }).join('');

            return `
                <div class="sidebar-category-group ${isOpen ? 'open' : ''}" data-group-id="${group.id}">
                    <button class="sidebar-category-header">
                        <span>${group.name}</span>
                        <span class="category-chevron">▶</span>
                    </button>
                    <div class="sidebar-category-content">
                        ${tasksHtml}
                    </div>
                </div>
            `;
        }).join('');

        // Attach listeners to newly rendered sidebar group items
        sidebarNav.querySelectorAll('.sidebar-category-header').forEach(header => {
            header.addEventListener('click', (e) => {
                const grp = header.closest('.sidebar-category-group');
                const groupId = grp.getAttribute('data-group-id');
                
                if (openCategories.has(groupId)) {
                    openCategories.delete(groupId);
                    grp.classList.remove('open');
                } else {
                    openCategories.add(groupId);
                    grp.classList.add('open');
                }
            });
        });

        sidebarNav.querySelectorAll('.sidebar-task-link').forEach(link => {
            link.addEventListener('click', () => {
                const taskId = link.getAttribute('data-task-id');
                selectTask(taskId);
            });
        });
    }

    // Render the active task on the main screen
    function renderActiveTask() {
        if (!activeTaskContainer) return;

        const task = TASKS_DATA.find(t => t.id === activeTaskId);
        if (!task) {
            activeTaskContainer.innerHTML = `<div class="info-card" style="text-align: center; padding: 3rem;">
                <h5>Kérjük, válassz egy feladatot az oldalsávból.</h5>
            </div>`;
            return;
        }

        // Check if task is locked
        if (task.isLocked) {
            activeTaskContainer.innerHTML = `
                <div class="locked-task-card">
                    <span class="locked-icon-shield">🔒</span>
                    <h2 class="locked-title">Kizárólagos Tartalom</h2>
                    <p class="locked-description">Ez a feladat (<strong>${task.title}</strong>) és a hozzá tartozó részletes megoldásmenet csak bejelentkezett felhasználók számára érhető el.</p>
                    <button class="btn-locked-action" id="btn-locked-login-trigger">Bejelentkezés</button>
                </div>
            `;
            
            const lockedTrigger = document.getElementById('btn-locked-login-trigger');
            if (lockedTrigger) {
                lockedTrigger.addEventListener('click', openLoginModal);
            }
            return;
        }

        const state = stepperStates[task.id];

        let subItemsHtml = '';
        if (task.subItems && task.subItems.length > 0) {
            subItemsHtml = `<div class="sub-items-grid">` + task.subItems.map(item => `
                <div class="sub-item-card">
                    <span class="sub-item-letter">${item.letter}</span>
                    <span>${item.text}</span>
                </div>
            `).join('') + `</div>`;
        }

        let diagramsHtml = '';
        if (task.diagrams && task.diagrams.length > 0) {
            diagramsHtml = `<div class="diagrams-showcase">` + task.diagrams.map(d => `
                <div class="diagram-box">
                    <div class="diagram-label">${d.label}</div>
                    <div class="diagram-svg-container">${d.svg}</div>
                </div>
            `).join('') + `</div>`;
        }

        // Build progress status toolbar if user is authenticated
        let statusSelectorHtml = '';
        if (isLoggedIn) {
            const currentStatus = taskStatuses[task.id] || 'default';
            statusSelectorHtml = `
                <div class="task-status-bar">
                    <button class="btn-status btn-status-kesz ${currentStatus === 'kesz' ? 'active' : ''}" data-task-id="${task.id}" data-action="kesz">
                        <span>✓</span> Kész
                    </button>
                    <button class="btn-status btn-status-atnezendo ${currentStatus === 'atnezendo' ? 'active' : ''}" data-task-id="${task.id}" data-action="atnezendo">
                        <span>★</span> Átnézendő
                    </button>
                </div>
            `;
        }

        // Build admin lesson assignment selector dropdown if authenticated as admin
        let lessonSelectorHtml = '';
        if (isLoggedIn && userRole === 'admin') {
            const activeLesson = taskLessons[task.id] || '';
            let optionsHtml = '<option value="">-- Nincs órához rendelve --</option>';
            for (let i = 1; i <= 20; i++) {
                optionsHtml += `<option value="${i}" ${activeLesson == i ? 'selected' : ''}>${i}. Óra</option>`;
            }
            lessonSelectorHtml = `
                <div class="lesson-select-wrapper">
                    <span class="lesson-select-label">Óra:</span>
                    <select class="lesson-select" id="lesson-select" data-task-id="${task.id}">
                        ${optionsHtml}
                    </select>
                </div>
            `;
        }

        // 1. Collapsible Statement Content
        const isStatementExpanded = state.statementExpanded;
        const statementSectionHtml = `
            <div class="statement-toggle-wrapper" style="margin-bottom: 1rem;">
                <button class="statement-toggle-btn ${isStatementExpanded ? 'expanded' : ''}" id="statement-toggle-${task.id}">
                    <span>📋 Feladat leírása</span>
                    <span class="statement-toggle-chevron">▼</span>
                </button>
                <div class="task-statement-content ${isStatementExpanded ? 'expanded' : ''}" id="statement-content-${task.id}">
                    <div class="task-statement-inner" style="min-height: 0; padding-top: 0.5rem; padding-bottom: 0.5rem;">
                        <div class="task-statement">${task.statement}</div>
                        ${subItemsHtml}
                        ${diagramsHtml}
                    </div>
                </div>
            </div>
        `;

        // 2. Collapsible Theory callout
        let theoryHtml = '';
        if (task.theory) {
            const isTheoryExpanded = state.theoryExpanded;
            theoryHtml = `
                <div class="theory-toggle-wrapper">
                    <button class="theory-toggle-btn ${isTheoryExpanded ? 'expanded' : ''}" id="theory-toggle-${task.id}">
                        <span>💡 Elméleti háttér megtekintése</span>
                        <span class="theory-toggle-chevron">▼</span>
                    </button>
                    <div class="theory-collapsible-wrapper ${isTheoryExpanded ? 'expanded' : ''}" id="theory-content-${task.id}">
                        <div class="theory-collapsible-inner" style="min-height: 0; padding-top: 0.5rem;">
                            <div class="theory-callout" style="display: block; margin: 0;">
                                <div class="theory-callout-header" style="display: none;">
                                    <span>💡</span>
                                    <span>${task.theory.title}</span>
                                </div>
                                <div class="theory-callout-content">
                                    ${task.theory.intro ? `<p>${task.theory.intro}</p>` : ''}
                                    <ul>
                                        ${task.theory.points.map(p => `<li>${p}</li>`).join('')}
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        // Build list of step panes
        const stepPanes = [];
        if (task.steps && task.steps.length > 0) {
            task.steps.forEach(s => {
                stepPanes.push({
                    type: 'step',
                    number: s.number,
                    title: `${s.number}. Lépés: ${s.title}`,
                    body: s.body
                });
            });
        }
        if (task.finalAnswer) {
            stepPanes.push({
                type: 'final',
                title: '🏆 Végső Összegzés',
                body: task.finalAnswer
            });
        }

        // Generate progress pills HTML
        const pillsHtml = stepPanes.map((pane, idx) => {
            const label = pane.type === 'final' ? '🏆 Összegzés' : `${pane.number}. lépés`;
            return `<button class="step-pill ${idx === 0 ? 'active' : ''}" data-step-idx="${idx}">${label}</button>`;
        }).join('');

        // Generate step content panes HTML
        const panesHtml = stepPanes.map((pane, idx) => {
            if (pane.type === 'final') {
                return `
                    <div class="step-content-pane ${idx === 0 ? 'active' : ''}" data-pane-idx="${idx}">
                        <div class="final-answer-box" style="margin-top: 0;">
                            <div class="final-answer-header">
                                <span>🏆</span>
                                <span>Végső Összegzés</span>
                            </div>
                            <div class="final-answer-text">${pane.body}</div>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div class="step-content-pane ${idx === 0 ? 'active' : ''}" data-pane-idx="${idx}">
                        <div class="solution-step" style="margin-bottom: 0;">
                            <div class="step-node">${pane.number}</div>
                            <div class="step-title">${pane.title}</div>
                            <div class="step-body">${pane.body}</div>
                        </div>
                    </div>
                `;
            }
        }).join('');

        // 3. Collapsible Stepper Content
        const isStepperExpanded = state.stepperExpanded;
        const stepperSectionHtml = `
            <div class="stepper-toggle-wrapper" style="margin-top: 1rem;">
                <button class="stepper-toggle-btn ${isStepperExpanded ? 'expanded' : ''}" id="stepper-toggle-${task.id}">
                    <span>📝 Megoldás végigvezetése</span>
                    <span class="stepper-toggle-chevron">▼</span>
                </button>
                <div class="stepper-collapsible-content ${isStepperExpanded ? 'expanded' : ''}" id="stepper-content-${task.id}">
                    <div class="stepper-collapsible-inner" style="min-height: 0; padding-top: 0.5rem;">
                        <div class="stepper-container" id="stepper-${task.id}">
                            <div class="stepper-header">
                                <div class="stepper-title">
                                    <span>📝</span>
                                    <span>Megoldás lépésről lépésre</span>
                                </div>
                                <div class="stepper-pills">
                                    ${pillsHtml}
                            </div>
                        </div>

                        <div class="stepper-content-viewport">
                            ${panesHtml}
                        </div>

                        <div class="stepper-controls">
                                <button class="btn-step-prev" disabled>◀ Előző lépés</button>
                                <span class="stepper-indicator">1 / ${stepPanes.length}</span>
                                <button class="btn-step-next">Következő lépés ▶</button>
                                <button class="btn-toggle-view">👁️ Mindet mutatja</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const idHeaderPillHtml = isLoggedIn && userRole === 'admin' ? `<span class="task-id-pill">ID: ${task.id}</span>` : '';

        activeTaskContainer.innerHTML = `
            <article class="task-card" id="${task.id}">
                <div style="margin-bottom: 1.5rem;">
                    <div class="task-accordion-meta" style="margin-bottom: 0.5rem; display: flex; align-items: center; width: 100%; flex-wrap: wrap; gap: 0.5rem;">
                        ${idHeaderPillHtml}
                        <span class="task-topic-pill">${task.categoryName}</span>
                        ${statusSelectorHtml}
                        ${lessonSelectorHtml}
                    </div>
                    <h2 class="task-title" style="font-size: 1.45rem; font-family: var(--font-heading); font-weight: 700; color: #ffffff; line-height: 1.35;">${getTaskDisplayTitle(task)}</h2>
                </div>

                <div class="task-accordion-body">
                    ${statementSectionHtml}
                    ${theoryHtml}
                    ${stepperSectionHtml}
                </div>
            </article>
        `;

        // Attach listener for Admin lesson assignment selector change
        if (isLoggedIn && userRole === 'admin') {
            const lessonSelect = document.getElementById('lesson-select');
            if (lessonSelect) {
                lessonSelect.addEventListener('change', async () => {
                    const newValue = lessonSelect.value;
                    const assignment = newValue === '' ? null : parseInt(newValue);
                    console.log("Lesson select change event triggered. Value selected:", newValue);

                    try {
                        const res = await fetch(getApiUrl('lessons'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ taskId: task.id, lesson: assignment })
                        });
                        
                        console.log("POST /api/lessons response status:", res.status);
                        if (res.ok) {
                            if (assignment === null) {
                                delete taskLessons[task.id];
                            } else {
                                taskLessons[task.id] = assignment;
                            }
                            // Re-render sidebar & active task view to refresh assignments and highlights
                            renderSidebar();
                            renderActiveTask();
                            console.log("Sidebar and active task re-rendered successfully with new assignment.");
                        } else {
                            console.error("Server returned non-ok response status for lesson assignment:", res.status);
                        }
                    } catch (err) {
                        console.error('Failed to save lesson assignment:', err);
                    }
                });
            }
        }

        // Attach listeners for status toggle buttons
        if (isLoggedIn) {
            activeTaskContainer.querySelectorAll('.btn-status').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const action = btn.getAttribute('data-action');
                    const currentStatus = taskStatuses[task.id] || 'default';
                    const newStatus = currentStatus === action ? 'default' : action;

                    try {
                        const updateRes = await fetch(getApiUrl('status'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ taskId: task.id, status: newStatus })
                        });
                        
                        if (updateRes.ok) {
                            if (newStatus === 'default') {
                                delete taskStatuses[task.id];
                            } else {
                                taskStatuses[task.id] = newStatus;
                            }
                            // Re-render task & sidebar to show updated dots/highlights
                            renderActiveTask();
                            renderSidebar();
                        }
                    } catch (err) {
                        console.error('Failed to update status on server:', err);
                    }
                });
            });
        }

        // Attach listeners for collapsible task statement
        const stmtToggleBtn = document.getElementById(`statement-toggle-${task.id}`);
        const stmtContentDiv = document.getElementById(`statement-content-${task.id}`);
        stmtToggleBtn.addEventListener('click', () => {
            const isExpanded = stmtContentDiv.classList.contains('expanded');
            if (isExpanded) {
                stmtContentDiv.classList.remove('expanded');
                stmtToggleBtn.classList.remove('expanded');
                state.statementExpanded = false;
            } else {
                stmtContentDiv.classList.add('expanded');
                stmtToggleBtn.classList.add('expanded');
                state.statementExpanded = true;
                if (window.MathJax && window.MathJax.typesetPromise) {
                    MathJax.typesetPromise([stmtContentDiv]).catch(() => {});
                }
            }
        });

        // Attach listeners for collapsible theory section
        if (task.theory) {
            const toggleBtn = document.getElementById(`theory-toggle-${task.id}`);
            const contentDiv = document.getElementById(`theory-content-${task.id}`);
            
            toggleBtn.addEventListener('click', () => {
                const isExpanded = contentDiv.classList.contains('expanded');
                if (isExpanded) {
                    contentDiv.classList.remove('expanded');
                    toggleBtn.classList.remove('expanded');
                    state.theoryExpanded = false;
                } else {
                    contentDiv.classList.add('expanded');
                    toggleBtn.classList.add('expanded');
                    state.theoryExpanded = true;
                    // Trigger typesetting inside theory callout when opened
                    if (window.MathJax && window.MathJax.typesetPromise) {
                        MathJax.typesetPromise([contentDiv]).catch(() => {});
                    }
                }
            });
        }

        // Attach listeners for collapsible stepper
        const stepToggleBtn = document.getElementById(`stepper-toggle-${task.id}`);
        const stepContentDiv = document.getElementById(`stepper-content-${task.id}`);
        stepToggleBtn.addEventListener('click', () => {
            const isExpanded = stepContentDiv.classList.contains('expanded');
            if (isExpanded) {
                stepContentDiv.classList.remove('expanded');
                stepToggleBtn.classList.remove('expanded');
                state.stepperExpanded = false;
            } else {
                stepContentDiv.classList.add('expanded');
                stepToggleBtn.classList.add('expanded');
                state.stepperExpanded = true;
                if (window.MathJax && window.MathJax.typesetPromise) {
                    MathJax.typesetPromise([stepContentDiv]).catch(() => {});
                }
            }
        });

        // Attach stepper listeners and initial stepper state render
        const totalSteps = stepPanes.length;
        attachStepperListeners(activeTaskContainer, task.id, totalSteps);
        updateStepperUI(task.id, totalSteps);

        // Typeset task statement and diagrams
        if (window.MathJax && window.MathJax.typesetPromise) {
            MathJax.typesetPromise([activeTaskContainer]).catch(() => {});
        }
    }

    // Update stepper visibility and button states based on active step
    function updateStepperUI(taskId, totalSteps) {
        const state = stepperStates[taskId];
        const stepperEl = document.getElementById(`stepper-${taskId}`);
        if (!stepperEl) return;

        const pills = stepperEl.querySelectorAll('.step-pill');
        const panes = stepperEl.querySelectorAll('.step-content-pane');
        const prevBtn = stepperEl.querySelector('.btn-step-prev');
        const nextBtn = stepperEl.querySelector('.btn-step-next');
        const indicator = stepperEl.querySelector('.stepper-indicator');
        const toggleViewBtn = stepperEl.querySelector('.btn-toggle-view');

        if (state.showAll) {
            stepperEl.classList.add('show-all');
            toggleViewBtn.classList.add('active-all');
            toggleViewBtn.innerHTML = '👁️ Léptető mód';
            return;
        } else {
            stepperEl.classList.remove('show-all');
            toggleViewBtn.classList.remove('active-all');
            toggleViewBtn.innerHTML = '👁️ Mindet mutatja';
        }

        // Update pills
        pills.forEach((pill, idx) => {
            pill.classList.remove('active', 'completed');
            if (idx === state.currentStep) {
                pill.classList.add('active');
            } else if (idx < state.currentStep) {
                pill.classList.add('completed');
            }
        });

        // Update panes
        panes.forEach((pane, idx) => {
            if (idx === state.currentStep) {
                pane.classList.add('active');
            } else {
                pane.classList.remove('active');
            }
        });

        // Update buttons & indicator
        prevBtn.disabled = state.currentStep === 0;
        indicator.textContent = `${state.currentStep + 1} / ${totalSteps}`;

        if (state.currentStep === totalSteps - 1) {
            nextBtn.innerHTML = 'Kész 🎉';
            nextBtn.disabled = true;
            nextBtn.style.opacity = '0.5';
        } else {
            nextBtn.innerHTML = 'Következő lépés ▶';
            nextBtn.disabled = false;
            nextBtn.style.opacity = '1';
        }

        // Trigger MathJax typesetting for the container
        if (window.MathJax && window.MathJax.typesetPromise) {
            MathJax.typesetPromise([stepperEl]).catch(() => {});
        }
    }

    // Attach step event listeners to a task container
    function attachStepperListeners(taskEl, taskId, totalSteps) {
        const prevBtn = taskEl.querySelector('.btn-step-prev');
        const nextBtn = taskEl.querySelector('.btn-step-next');
        const toggleViewBtn = taskEl.querySelector('.btn-toggle-view');
        const pills = taskEl.querySelectorAll('.step-pill');

        prevBtn.addEventListener('click', () => {
            if (stepperStates[taskId].currentStep > 0) {
                stepperStates[taskId].currentStep--;
                updateStepperUI(taskId, totalSteps);
            }
        });

        nextBtn.addEventListener('click', () => {
            if (stepperStates[taskId].currentStep < totalSteps - 1) {
                stepperStates[taskId].currentStep++;
                updateStepperUI(taskId, totalSteps);
            }
        });

        toggleViewBtn.addEventListener('click', () => {
            stepperStates[taskId].showAll = !stepperStates[taskId].showAll;
            updateStepperUI(taskId, totalSteps);
        });

        pills.forEach(pill => {
            pill.addEventListener('click', () => {
                const targetIdx = parseInt(pill.getAttribute('data-step-idx'));
                stepperStates[taskId].currentStep = targetIdx;
                stepperStates[taskId].showAll = false;
                updateStepperUI(taskId, totalSteps);
            });
        });
    }

    // Search and filter input logic
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            
            if (typeof TASKS_DATA === 'undefined') return;

            currentTasksList = TASKS_DATA.filter(task => {
                const taskId = task.id.toLowerCase();
                const title = task.title.toLowerCase();
                const statement = task.statement ? task.statement.toLowerCase() : '';
                return !query || taskId.includes(query) || title.includes(query) || statement.includes(query);
            });

            // Expand all open categories that have matching tasks when query is typed
            if (query) {
                currentTasksList.forEach(task => {
                    if (sidebarListMode === 'categories') {
                        openCategories.add(task.category);
                    } else {
                        const activeLesson = taskLessons[task.id] || 'unassigned';
                        openCategories.add(`lesson-${activeLesson}`);
                    }
                });
            }

            renderSidebar();
            
            // If active task is still in list, keep it. Otherwise, select the first matching task
            const activeStillInList = currentTasksList.some(t => t.id === activeTaskId);
            if (!activeStillInList && currentTasksList.length > 0) {
                selectTask(currentTasksList[0].id);
            } else {
                updateNavigationButtons();
            }
        });
    }

    // Bind sidebar view toggles
    if (btnViewCategories) {
        btnViewCategories.addEventListener('click', () => {
            if (sidebarListMode !== 'categories') {
                sidebarListMode = 'categories';
                btnViewCategories.classList.add('active');
                btnViewLessons.classList.remove('active');
                openCategories.clear();
                // Auto-open current task's category
                const task = TASKS_DATA.find(t => t.id === activeTaskId);
                if (task) openCategories.add(task.category);
                renderSidebar();
            }
        });
    }

    if (btnViewLessons) {
        btnViewLessons.addEventListener('click', () => {
            if (sidebarListMode !== 'lessons') {
                sidebarListMode = 'lessons';
                btnViewLessons.classList.add('active');
                btnViewCategories.classList.remove('active');
                openCategories.clear();
                // Auto-open current task's lesson group
                const activeLesson = taskLessons[activeTaskId] || 'unassigned';
                openCategories.add(`lesson-${activeLesson}`);
                renderSidebar();
            }
        });
    }

    // Sidebar Close / Open Toggle Click events
    if (sidebarCloseBtn) {
        sidebarCloseBtn.addEventListener('click', () => {
            sidebar.classList.add('collapsed');
        });
    }

    if (sidebarOpenBtn) {
        sidebarOpenBtn.addEventListener('click', () => {
            sidebar.classList.remove('collapsed');
        });
    }

    // Footer Next / Prev Task Navigation buttons click events
    if (prevTaskBtn) {
        prevTaskBtn.addEventListener('click', () => {
            const activeIndex = currentTasksList.findIndex(t => t.id === activeTaskId);
            if (activeIndex > 0) {
                selectTask(currentTasksList[activeIndex - 1].id);
            }
        });
    }

    if (nextTaskBtn) {
        nextTaskBtn.addEventListener('click', () => {
            const activeIndex = currentTasksList.findIndex(t => t.id === activeTaskId);
            if (activeIndex !== -1 && activeIndex < currentTasksList.length - 1) {
                selectTask(currentTasksList[activeIndex + 1].id);
            }
        });
    }

    // Open Login Modal function
    function openLoginModal() {
        if (loginModal) {
            loginErrorMsg.classList.add('hidden');
            loginUsernameInput.value = '';
            loginPasswordInput.value = '';
            loginModal.classList.remove('hidden');
        }
    }

    // Close Login Modal function
    function closeLoginModal() {
        if (loginModal) {
            loginModal.classList.add('hidden');
        }
    }

    // Login Toggle button click event in Header
    if (btnLoginHeader) {
        btnLoginHeader.addEventListener('click', async () => {
            if (isLoggedIn) {
                // Logout Action (POST to server)
                try {
                    const res = await fetch(getApiUrl('logout'), { method: 'POST' });
                    if (res.ok) {
                        loadDataFromServer();
                    }
                } catch (err) {
                    console.error('Logout failed:', err);
                }
            } else {
                // Open Login Form
                openLoginModal();
            }
        });
    }

    if (loginModalClose) {
        loginModalClose.addEventListener('click', closeLoginModal);
    }

    // Form Submission for Authentication
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = loginUsernameInput.value.trim();
            const password = loginPasswordInput.value;

            try {
                const loginRes = await fetch(getApiUrl('login'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                if (loginRes.ok) {
                    closeLoginModal();
                    loadDataFromServer(); // Re-fetch now unlocked database
                } else {
                    loginErrorMsg.classList.remove('hidden');
                }
            } catch (err) {
                console.error('Authentication request failed:', err);
                loginErrorMsg.classList.remove('hidden');
            }
        });
    }

    // Close modal when clicking outside card
    if (loginModal) {
        loginModal.addEventListener('click', (e) => {
            if (e.target === loginModal) {
                closeLoginModal();
            }
        });
    }

    // Initial load from Node Backend Server API
    loadDataFromServer();
});
