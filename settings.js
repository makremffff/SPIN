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
       i18n TRANSLATIONS
    ══════════════════════════════════════════ */
    const TRANSLATIONS = {
        ar: {
            dir: 'rtl',
            font: "'Cairo', sans-serif",
            app_name: 'الربح عربي',
            earn_title: 'الربح',
            tasks_title: 'المهام',
            withdraw_title: 'السحب',
            invite_title: 'دعوة الأصدقاء',
            settings_title: 'الإعدادات',
            settings_lang_label: 'اللغة',
            // nav
            nav_home: 'الرئيسية',
            nav_tasks: 'المهام',
            nav_earn: 'الربح',
            nav_withdraw: 'السحب',
            // home
            balance: 'الرصيد',
            friends: 'صديق مدعو',
            tasks_done: 'مهمة منجزة',
            charge: 'شحن رصيد',
            withdraw: 'سحب رصيد',
            daily_tasks: 'مهام اليوم',
            // earn
            daily_ads: 'الإعلانات اليومية',
            watch_ad: 'شاهد إعلاناً',
            get_balance: 'واحصل على رصيد فوري',
            pts: 'نقطة',
            earned_today: 'مكتسب اليوم',
            ads_watched: 'إعلان شوهد',
            daily_limit: 'الحد اليومي',
            all_done_title: 'أحسنت! انتهيت من كل الإعلانات',
            all_done_sub: 'عد غداً للحصول على 10 إعلانات جديدة',
            invite_btn_title: 'دعوة الأصدقاء',
            invite_btn_sub: 'ادعُ أصدقاءك واربح معاً',
            coming_soon: 'قريباً',
            soon: 'قريباً',
            achievements: 'الإنجازات',
            achievements_sub: 'اكسب شارات وكافئ نفسك',
            contests: 'المسابقات',
            contests_sub: 'تنافس واربح جوائز كبرى',
            gift_title: 'مكافأة يومية',
            gift_sub: 'استلم هديتك اليومية الآن',
            // tasks page
            no_tasks: 'لا توجد مهام حالياً',
            no_tasks_sub: 'سيتم إضافة مهام جديدة قريباً.\nتابعنا للحصول على المزيد من النقاط!',
            upcoming_tasks: 'المهام القادمة',
            // home stats
            balance_label: 'الرصيد',
            friends_label: 'صديق مدعو',
            tasks_done_label: 'مهمة منجزة',
            charge_label: 'شحن رصيد',
            withdraw_label: 'سحب رصيد',
            daily_tasks_section: 'مهام اليوم',
            // tasks page
            task_watch_ad: 'مشاهدة إعلان',
            task_share: 'مشاركة التطبيق',
            task_invite: 'دعوة صديق',
            upcoming_task_video: 'مشاهدة فيديو',
            upcoming_task_review: 'تقييم التطبيق',
            // withdraw page
            withdraw_page_balance: 'إجمالي الرصيد',
            withdraw_methods_title: 'طرق السحب',
            withdraw_history_title: 'سجل المعاملات',
            no_transactions: 'لا توجد معاملات بعد',
            no_transactions_sub: 'ستظهر هنا سجلات السحب والإيداع',
            // invite page
            invite_hero_title: 'ادعُ أصدقاءك واربح',
            invite_hero_sub: 'شارك رابطك الخاص واحصل على مكافأة\nفورية لكل صديق ينضم عبرك',
            invite_pts_per_ref: 'نقطة لكل إحالة',
            total_referrals: 'إجمالي الإحالات',
            earned_from_refs: 'مكتسب من الإحالات',
            your_ref_link: 'رابط الإحالة الخاص بك',
            copy_link: 'نسخ الرابط',
            friends_list: 'الأصدقاء المدعوون',
            // withdraw page
            balance_available: 'رصيدك المتاح للسحب',
            withdraw_history_title: 'سجل السحوبات',
            no_transactions: 'لا توجد سحوبات سابقة',
            min_label: 'الحد الأدنى',
            ton_wallet: 'محفظة TON',
            paypal_name: 'باي بال',
            fawry_name: 'فوري باي',
            available_badge: 'متاح',
            // ad overlay
            ad_loading: 'جاري تحميل الإعلان...',
            // gift overlay
            gift_preparing: 'جاري تحضير هديتك...',
            gift_claim_btn: 'استلم هديتك',
            gift_claimed: 'تم الاستلام ✓',
            gift_already_claimed: 'تم استلام هديتك اليوم ✓',
            // toast messages
            toast_copy_title: 'تم نسخ الرابط ✓',
            toast_copy_desc: 'شارك رابطك مع أصدقائك',
            toast_ad_done_title: 'أكملت جميع الإعلانات! 🏆',
            toast_ad_done_sub: 'حصلت على 500 نقطة اليوم',
            toast_ad_fire: 'رائع! استمر! 🔥',
            toast_ad_watch: 'تمت المشاهدة ✓',
            toast_ad_pts: 'أضفنا تذاكر المسابقة إلى رصيدك',
            toast_gift_title: 'تم استلام هديتك!',
            // invite copy button
            copy_btn_done: 'تم النسخ!',
            copy_btn_default: 'نسخ الرابط',
            // rank label
            rank_label: 'الترتيب',
            // user greeting
            user_greeting: 'مرحباً بعودتك 👋',
            // invite page title heading
            invite_page_title: 'دعوة الأصدقاء',
            // tasks page title
            tasks_page_title: 'المهام',
            // tasks empty
            tasks_empty_title: 'لا توجد مهام حالياً',
            tasks_empty_desc: 'سيتم إضافة مهام جديدة قريباً.\nتابعنا للحصول على المزيد من النقاط!',
            // see more referrals
            more_friends: '+44 صديق آخر',
        },
        en: {
            dir: 'ltr',
            font: "'Cairo', sans-serif",
            app_name: 'Arabi Earn',
            earn_title: 'Earn',
            tasks_title: 'Tasks',
            withdraw_title: 'Withdraw',
            invite_title: 'Invite Friends',
            settings_title: 'Settings',
            settings_lang_label: 'Language',
            nav_home: 'Home',
            nav_tasks: 'Tasks',
            nav_earn: 'Earn',
            nav_withdraw: 'Wallet',
            balance: 'Balance',
            friends: 'Friends',
            tasks_done: 'Tasks Done',
            charge: 'Deposit',
            withdraw: 'Withdraw',
            daily_tasks: "Today's Tasks",
            daily_ads: 'Daily Ads',
            watch_ad: 'Watch an Ad',
            get_balance: 'Get instant rewards',
            pts: 'pts',
            earned_today: 'Earned Today',
            ads_watched: 'Ads Watched',
            daily_limit: 'Daily Limit',
            all_done_title: 'Great! All ads completed',
            all_done_sub: 'Come back tomorrow for 10 new ads',
            invite_btn_title: 'Invite Friends',
            invite_btn_sub: 'Invite friends and earn together',
            coming_soon: 'Coming Soon',
            soon: 'Soon',
            achievements: 'Achievements',
            achievements_sub: 'Earn badges and reward yourself',
            contests: 'Contests',
            contests_sub: 'Compete and win big prizes',
            gift_title: 'Daily Reward',
            gift_sub: 'Claim your daily gift now',
            no_tasks: 'No tasks available',
            no_tasks_sub: 'New tasks will be added soon.\nFollow us for more points!',
            upcoming_tasks: 'Upcoming Tasks',
            // home stats
            balance_label: 'Balance',
            friends_label: 'Invited Friends',
            tasks_done_label: 'Tasks Done',
            charge_label: 'Deposit',
            withdraw_label: 'Withdraw',
            daily_tasks_section: "Today's Tasks",
            // tasks page
            task_watch_ad: 'Watch Ad',
            task_share: 'Share App',
            task_invite: 'Invite Friend',
            upcoming_task_video: 'Watch Video',
            upcoming_task_review: 'Rate App',
            // withdraw page
            withdraw_page_balance: 'Total Balance',
            withdraw_methods_title: 'Withdrawal Methods',
            withdraw_history_title: 'Transaction History',
            no_transactions: 'No transactions yet',
            no_transactions_sub: 'Withdrawal and deposit records will appear here',
            // invite page
            invite_hero_title: 'Invite Friends & Earn',
            invite_hero_sub: 'Share your unique link and get an instant\nreward for every friend who joins through you',
            invite_pts_per_ref: 'points per referral',
            total_referrals: 'Total Referrals',
            earned_from_refs: 'Earned from Referrals',
            your_ref_link: 'Your Referral Link',
            copy_link: 'Copy Link',
            friends_list: 'Invited Friends',
            // withdraw page
            balance_available: 'Your available balance',
            withdraw_history_title: 'Withdrawal History',
            no_transactions: 'No withdrawals yet',
            min_label: 'Minimum',
            ton_wallet: 'TON Wallet',
            paypal_name: 'PayPal',
            fawry_name: 'Fawry Pay',
            available_badge: 'Active',
            // ad overlay
            ad_loading: 'Loading ad...',
            // gift overlay
            gift_preparing: 'Preparing your gift...',
            gift_claim_btn: 'Claim Gift',
            gift_claimed: 'Claimed ✓',
            gift_already_claimed: 'Already claimed today ✓',
            // toast messages
            toast_copy_title: 'Link copied ✓',
            toast_copy_desc: 'Share your link with friends',
            toast_ad_done_title: 'All ads done! 🏆',
            toast_ad_done_sub: 'You earned 500 points today',
            toast_ad_fire: 'Great! Keep going! 🔥',
            toast_ad_watch: 'Ad watched ✓',
            toast_ad_pts: 'We added competition tickets to your balance',
            toast_gift_title: 'Gift claimed!',
            // invite copy button
            copy_btn_done: 'Copied!',
            copy_btn_default: 'Copy Link',
            // rank label
            rank_label: 'Rank',
            // user greeting
            user_greeting: 'Welcome back 👋',
            // invite page title heading
            invite_page_title: 'Invite Friends',
            // tasks page title
            tasks_page_title: 'Tasks',
            // tasks empty
            tasks_empty_title: 'No tasks available',
            tasks_empty_desc: 'New tasks will be added soon.\nFollow us for more points!',
            // see more referrals
            more_friends: '+44 more friends',
        },
        ru: {
            dir: 'ltr',
            font: "'Cairo', sans-serif",
            app_name: 'Arabi Заработок',
            earn_title: 'Заработок',
            tasks_title: 'Задания',
            withdraw_title: 'Вывод',
            invite_title: 'Пригласить друзей',
            settings_title: 'Настройки',
            settings_lang_label: 'Язык',
            nav_home: 'Главная',
            nav_tasks: 'Задания',
            nav_earn: 'Заработок',
            nav_withdraw: 'Кошелёк',
            balance: 'Баланс',
            friends: 'Друзей',
            tasks_done: 'Задач',
            charge: 'Пополнить',
            withdraw: 'Вывести',
            daily_tasks: 'Задания дня',
            daily_ads: 'Ежедневная реклама',
            watch_ad: 'Смотреть рекламу',
            get_balance: 'Получай мгновенное вознаграждение',
            pts: 'очк.',
            earned_today: 'Заработано сегодня',
            ads_watched: 'Рекламы просмотрено',
            daily_limit: 'Дневной лимит',
            all_done_title: 'Отлично! Вся реклама просмотрена',
            all_done_sub: 'Возвращайся завтра за новыми 10 рекламами',
            invite_btn_title: 'Пригласить друзей',
            invite_btn_sub: 'Приглашай друзей и зарабатывай вместе',
            coming_soon: 'Скоро',
            soon: 'Скоро',
            achievements: 'Достижения',
            achievements_sub: 'Зарабатывай значки и награды',
            contests: 'Конкурсы',
            contests_sub: 'Участвуй и выигрывай призы',
            gift_title: 'Ежедневная награда',
            gift_sub: 'Получи свой ежедневный подарок',
            no_tasks: 'Нет доступных заданий',
            no_tasks_sub: 'Новые задания появятся скоро.\nСледите за обновлениями!',
            upcoming_tasks: 'Предстоящие задания',
            // home stats
            balance_label: 'Баланс',
            friends_label: 'Приглашённых',
            tasks_done_label: 'Задач',
            charge_label: 'Пополнить',
            withdraw_label: 'Вывести',
            daily_tasks_section: 'Задания дня',
            // tasks page
            task_watch_ad: 'Смотреть рекламу',
            task_share: 'Поделиться',
            task_invite: 'Пригласить друга',
            upcoming_task_video: 'Смотреть видео',
            upcoming_task_review: 'Оценить приложение',
            // withdraw page
            withdraw_page_balance: 'Общий баланс',
            withdraw_methods_title: 'Методы вывода',
            withdraw_history_title: 'История транзакций',
            no_transactions: 'Транзакций пока нет',
            no_transactions_sub: 'Здесь будут записи о выводе и пополнении',
            // invite page
            invite_hero_title: 'Приглашай и зарабатывай',
            invite_hero_sub: 'Поделись своей ссылкой и получай\nмгновенное вознаграждение за каждого друга',
            invite_pts_per_ref: 'очков за реферала',
            total_referrals: 'Всего рефералов',
            earned_from_refs: 'Заработано с рефералов',
            your_ref_link: 'Ваша реферальная ссылка',
            copy_link: 'Копировать ссылку',
            friends_list: 'Приглашённые друзья',
            // withdraw page
            balance_available: 'Доступный баланс',
            withdraw_history_title: 'История выводов',
            no_transactions: 'Выводов пока нет',
            min_label: 'Минимум',
            ton_wallet: 'TON Кошелёк',
            paypal_name: 'PayPal',
            fawry_name: 'Fawry Pay',
            available_badge: 'Доступно',
            // ad overlay
            ad_loading: 'Загрузка рекламы...',
            // gift overlay
            gift_preparing: 'Подготовка подарка...',
            gift_claim_btn: 'Получить подарок',
            gift_claimed: 'Получено ✓',
            gift_already_claimed: 'Сегодня уже получено ✓',
            // toast messages
            toast_copy_title: 'Ссылка скопирована ✓',
            toast_copy_desc: 'Поделитесь ссылкой с друзьями',
            toast_ad_done_title: 'Вся реклама просмотрена! 🏆',
            toast_ad_done_sub: 'Вы заработали 500 очков сегодня',
            toast_ad_fire: 'Отлично! Продолжай! 🔥',
            toast_ad_watch: 'Реклама просмотрена ✓',
            toast_ad_pts: 'Мы добавили билеты конкурса на ваш баланс',
            toast_gift_title: 'Подарок получен!',
            // invite copy button
            copy_btn_done: 'Скопировано!',
            copy_btn_default: 'Скопировать',
            // rank label
            rank_label: 'Место',
            // user greeting
            user_greeting: 'С возвращением 👋',
            // invite page title heading
            invite_page_title: 'Пригласить друзей',
            // tasks page title
            tasks_page_title: 'Задания',
            // tasks empty
            tasks_empty_title: 'Нет доступных заданий',
            tasks_empty_desc: 'Новые задания появятся скоро.\nСледите за обновлениями!',
            // see more referrals
            more_friends: '+44 других друзей',
        }
    };

    let currentLang = 'ar';

    function setLang(lang) {
        currentLang = lang;
        const t = TRANSLATIONS[lang];

        // Document direction & lang
        document.documentElement.lang = lang;
        document.documentElement.dir = t.dir;
        document.body.style.fontFamily = t.font;

        // text-align for RTL/LTR elements that use text-align:right
        const rtl = lang === 'ar';

        // Apply all data-i18n elements
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (t[key] !== undefined) el.textContent = t[key];
        });

        // Nav labels (by data-nav-label)
        document.querySelectorAll('[data-nav-label]').forEach(el => {
            const key = el.getAttribute('data-nav-label');
            if (t[key] !== undefined) el.textContent = t[key];
        });

        // Settings drawer
        document.getElementById('settings-title').textContent = t.settings_title;
        document.getElementById('settings-lang-label').textContent = t.settings_lang_label;

        // Update lang selector UI
        ['ar','en','ru'].forEach(l => {
            const row = document.getElementById('lang-' + l);
            const chk = document.getElementById('check-' + l);
            if (l === lang) {
                row.style.border = '1.5px solid rgba(251,191,36,0.4)';
                row.style.background = 'rgba(251,191,36,0.08)';
                chk.style.opacity = '1';
                chk.style.background = '#fbbf24';
            } else {
                row.style.border = '1px solid rgba(255,255,255,0.08)';
                row.style.background = 'rgba(255,255,255,0.04)';
                chk.style.opacity = '0';
                chk.style.background = 'rgba(255,255,255,0.08)';
            }
        });

        // Flip text-align on info blocks that should follow dir
        document.querySelectorAll('.user-info, .ad-btn-text, .toast-body').forEach(el => {
            el.style.textAlign = rtl ? 'right' : 'left';
        });

        // method-info text-align follows dir
        document.querySelectorAll('.method-info').forEach(el => {
            el.style.textAlign = rtl ? 'right' : 'left';
        });

        // Nav pills direction
        document.querySelectorAll('.method-item').forEach(el => {
            el.style.direction = t.dir;
        });

        // invite hero sub uses <br> — re-inject to support line breaks
        const heroSub = document.querySelector('.invite-hero-sub');
        if (heroSub && t.invite_hero_sub) {
            heroSub.innerHTML = t.invite_hero_sub.replace(/\n/g, '<br>');
        }

        // tasks empty desc — re-inject for line breaks
        const emptyDesc = document.querySelector('.empty-desc[data-i18n="no_tasks_sub"]');
        if (emptyDesc && t.no_tasks_sub) {
            emptyDesc.innerHTML = t.no_tasks_sub.replace(/\n/g, '<br>');
        }

        // Copy btn reset label (in case it wasn't mid-copy)
        const copyBtn = document.getElementById('copy-btn');
        if (copyBtn && !copyBtn.classList.contains('copied')) {
            copyBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                </svg>
                ${t.copy_btn_default || t.copy_link}
            `;
        }

        closeSettings();
    }

    // Init — mark nav labels with data-nav-label
    document.addEventListener('DOMContentLoaded', () => {
        // Already set to Arabic by default
    });