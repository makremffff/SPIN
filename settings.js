    /* ══════════════════════════════════════════
       SETTINGS DRAWER
    ══════════════════════════════════════════ */
    function openSettings() {
        const bd = document.getElementById('settings-backdrop');
        const dr = document.getElementById('settings-drawer');
        if (bd) { bd.style.opacity = '1'; bd.style.pointerEvents = 'all'; }
        if (dr) dr.style.transform = 'translateY(0)';
    }
    function closeSettings() {
        const bd = document.getElementById('settings-backdrop');
        const dr = document.getElementById('settings-drawer');
        if (bd) { bd.style.opacity = '0'; bd.style.pointerEvents = 'none'; }
        if (dr) dr.style.transform = 'translateY(110%)';
    }

    /* ══════════════════════════════════════════
       LANGUAGE SWITCHER
       يستخدم _I18N و _applyTranslations المُعرَّفَين
       في نفس index.html — مصدر واحد للترجمات
    ══════════════════════════════════════════ */
    function setLang(lang) {
        // ── تطبيق الترجمات عبر النظام الموحّد
        if (typeof window._applyTranslations === 'function') {
            window._applyTranslations(lang);
        }

        const t   = (window._I18N && window._I18N[lang]) ? window._I18N[lang] : {};
        const rtl = (lang === 'ar');

        // ── اتجاه الصفحة والخط
        document.documentElement.lang = lang;
        document.documentElement.dir  = rtl ? 'rtl' : 'ltr';

        // ── عناصر الإعدادات الثابتة (id-based)
        const settingsTitle = document.getElementById('settings-title');
        const settingsLang  = document.getElementById('settings-lang-label');
        if (settingsTitle && t.settings_title)    settingsTitle.textContent    = t.settings_title;
        if (settingsLang  && t.settings_lang_label) settingsLang.textContent   = t.settings_lang_label;

        // ── تحديث واجهة اختيار اللغة
        ['ar','en','ru'].forEach(l => {
            const row = document.getElementById('lang-' + l);
            const chk = document.getElementById('check-' + l);
            if (!row || !chk) return;
            if (l === lang) {
                row.style.border     = '1.5px solid rgba(251,191,36,0.4)';
                row.style.background = 'rgba(251,191,36,0.08)';
                chk.style.opacity    = '1';
                chk.style.background = '#fbbf24';
            } else {
                row.style.border     = '1px solid rgba(255,255,255,0.08)';
                row.style.background = 'rgba(255,255,255,0.04)';
                chk.style.opacity    = '0';
                chk.style.background = 'rgba(255,255,255,0.08)';
            }
        });

        // ── محاذاة text-align للكتل التي تتبع الاتجاه
        document.querySelectorAll('.user-info, .ad-btn-text, .toast-body').forEach(el => {
            el.style.textAlign = rtl ? 'right' : 'left';
        });
        document.querySelectorAll('.method-info').forEach(el => {
            el.style.textAlign = rtl ? 'right' : 'left';
        });
        document.querySelectorAll('.method-item').forEach(el => {
            el.style.direction = rtl ? 'rtl' : 'ltr';
        });

        // ── زر النسخ — إعادة تعيين النص إذا لم يكن في حالة نسخ
        const copyBtn = document.getElementById('copy-btn');
        if (copyBtn && !copyBtn.classList.contains('copied')) {
            copyBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                </svg>
                ${t.copy_btn_text || t.copy_link || 'Copy'}
            `;
        }

        closeSettings();
    }

    document.addEventListener('DOMContentLoaded', () => {
        // اللغة مُطبَّقة بالفعل عند تهيئة الصفحة
    });
