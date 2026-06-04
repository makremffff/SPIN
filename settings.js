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
            toast_ad_pts: 'أضفنا 50 نقطة إلى رصيدك',
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

            /* ── JS dynamic strings ── */
            // Partial ad notice
            partial_ad_warning: '⚠️ يجب عليك التفاعل مع الإعلان<br>للحصول على الجائزة الكاملة',
            partial_ad_got: 'حصلت على',
            partial_ad_pts_pct: 'نقطة (50%)',
            partial_ad_instead: 'بدلاً من',
            partial_ad_full_pts: 'نقطة كاملة',
            partial_ad_ok: 'حسناً، فهمت!',
            // Watch ad flow
            wait_a_moment: 'انتظر قليلاً',
            seconds_suffix: 'ثانية',
            ad_sdk_failed: 'تعذّر تحميل الإعلان',
            check_connection: 'تحقق من اتصالك',
            ad_loading_label: 'جاري تحميل الإعلان...',
            ad_incomplete: 'الإعلان لم يكتمل',
            watch_ad_to_end: 'شاهد الإعلان حتى النهاية',
            ad_word: 'إعلان',
            ad_next_after: '✓ — التالي بعد',
            processing_error: 'خطأ في المعالجة',
            try_again: 'حاول مرة أخرى',
            watch_btn: 'شاهد',
            sending_label: 'جاري الإرسال...',
            // Ad reward toasts/notifs
            partial_ad_notif: 'مكافأة إعلان جزئية',
            pts_pct_label: 'نقطة (50%)',
            added_prefix: 'تم إضافة +',
            pts_suffix: 'نقطة',
            watched_prefix: 'شاهدت',
            ads_today_suffix: 'إعلان اليوم',
            ad_reward_notif: 'مكافأة إعلان',
            pts_added_to_bal: 'نقطة أُضيفت لرصيدك',
            daily_ads_done_toast: 'انتهت إعلانات اليوم 🏆',
            come_back_tomorrow: 'عُد غداً لمزيد من النقاط',
            // Daily mission
            mission_reward_title: 'مكافأة المهمة ✓',
            already_claimed: 'تم الاستلام مسبقاً',
            error_occurred: 'حدث خطأ',
            daily_mission_notif: 'مكافأة مهمة يومية ✓',
            // Channel tasks
            not_joined_channel: 'لم تنضم للقناة بعد ❌',
            click_join_first: 'اضغط «انضم» أولاً',
            already_verified: 'تم التحقق مسبقاً ✓',
            make_sure_joined: 'تأكد من انضمامك للقناة',
            then_retry: 'ثم أعد المحاولة',
            joined_channel_toast: 'انضممت للقناة! 🎉',
            tg_channel_task_notif: 'مهمة قناة تيليغرام ✓',
            channel_task_notif: 'مهمة قناة ✓',
            channel_hint_text: 'اضغط «تحقق» بعد الاشتراك في القناة',
            completed_badge: 'مكتمل',
            max_members: 'أقصى',
            members_suffix: 'عضو',
            // Referral
            n_friends_badge: 'صديق',
            n_more_friends_suffix: 'صديق آخر',
            pending_activation: 'بانتظار',
            default_username: 'مستخدم',
            n_requests_suffix: 'طلب',
            // Withdraw history
            withdraw_ton_label: 'سحب TON',
            status_completed: 'مكتمل',
            status_rejected: 'مرفوض',
            status_pending: 'قيد المعالجة',
            // Level / tier
            tier_gold_label: 'مستوى ذهبي',
            tier_silver_label: 'مستوى فضي',
            tier_green_label: 'مستوى أخضر',
            level_prefix: 'المستوى',
            // Home ticker
            ticker_balance: 'رصيدك',
            ticker_pts: 'نقطة',
            ticker_level: 'المستوى',
            ticker_friends: 'أصدقاء',
            ticker_tasks: 'مهام',
            // Daily gift overlay (JS)
            gift_already_claimed_today: 'تم استلام هديتك اليوم ✓',
            gift_claimed_btn: 'تم الاستلام ✓',
            gift_claimed_toast: 'تم استلام هديتك!',
            gift_daily_notif: 'هدية يومية ✓',
            pts_added_suffix: 'نقطة أُضيفت لرصيدك',
            // Gift day labels (fallback)
            gift_day_1: 'اليوم الأول',
            gift_day_1_desc: 'مبروك! استمر يومياً لتضاعف مكافآتك!',
            gift_day_2: 'اليوم الثاني',
            gift_day_2_desc: 'يومان متتاليان! المثابرة مفتاح النجاح.',
            gift_day_3: 'اليوم الثالث',
            gift_day_3_desc: 'ثلاثة أيام متتالية!',
            gift_day_4: 'اليوم الرابع',
            gift_day_4_desc: 'أسبوعك يقترب!',
            gift_day_5: 'اليوم الخامس',
            gift_day_5_desc: 'خمسة أيام!',
            gift_day_6: 'اليوم السادس',
            gift_day_6_desc: 'يوم واحد ويكتمل أسبوعك!',
            gift_day_7: 'اليوم السابع',
            gift_day_7_desc: 'أسبوع كامل! مكافأة ضخمة.',
            gift_day_prefix: 'اليوم',
            // TON Withdraw overlay
            submit_withdraw_btn: 'إرسال طلب السحب',
            insufficient_balance_err: 'رصيدك غير كافٍ',
            level_required_prefix: 'يتطلب المستوى',
            level_required_suffix: 'للسحب',
            error_try_again: 'حدث خطأ، حاول مجدداً',
            withdraw_sent_toast: 'تم إرسال طلب السحب! 🎉',
            withdraw_processing_desc: 'سيتم معالجة طلبك قريباً',
            withdraw_ton_notif: 'طلب سحب TON مُرسَل',
            pts_processing_suffix: 'نقطة قيد المعالجة',
            // Adsgram task
            verify_error: 'خطأ في التحقق',
            ad_task_done: 'مهمة إعلانية مكتملة 🎉',
            ad_task_notif: 'مهمة إعلانية ✓',
            wait_btn: 'انتظر',
            restart_app: 'أعد تشغيل التطبيق',
            session_too_long: 'الجلسة طويلة جداً',
            task_load_error: 'خطأ في تحميل المهمة',
            try_later: 'حاول لاحقاً',
            // Monetag
            loading_sdk: 'جارٍ تحميل SDK...',
            monetag_loading: 'جارٍ...',
            monetag_daily_limit_reached: 'وصلت الحد اليومي لـ Monetag',
            wait_n_sec_prefix: 'انتظر',
            connection_error: 'خطأ في الاتصال',
            // Share
            share_msg_text: 'انضم معي في تطبيق الربح العربي واربح نقاط مجانية! 🎁',
            copy_svg_label: 'نسخ',
            join_channel_btn: 'اشترك',
            verify_channel_btn: 'تحقق',
            left_channel_toast: 'غادرت قناة',
            penalty_pts_prefix: 'تم خصم',
            rejoin_to_restore: 'انضم مجدداً لاستعادة المهمة',
            // Time ago
            time_now: 'الآن',
            time_ago_min_fmt: 'منذ {n} دقيقة',
            time_ago_hr_fmt: 'منذ {n} ساعة',
            time_ago_day_fmt: 'منذ {n} يوم',
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
            toast_ad_pts: 'We added 50 points to your balance',
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

            /* ── JS dynamic strings ── */
            // Partial ad notice
            partial_ad_warning: '⚠️ You must interact with the ad<br>to get the full reward',
            partial_ad_got: 'You received',
            partial_ad_pts_pct: 'pts (50%)',
            partial_ad_instead: 'instead of',
            partial_ad_full_pts: 'full pts',
            partial_ad_ok: 'Got it!',
            // Watch ad flow
            wait_a_moment: 'Wait a moment',
            seconds_suffix: 'sec',
            ad_sdk_failed: 'Ad failed to load',
            check_connection: 'Check your connection',
            ad_loading_label: 'Loading ad...',
            ad_incomplete: 'Ad incomplete',
            watch_ad_to_end: 'Watch the ad to the end',
            ad_word: 'Ad',
            ad_next_after: '✓ — next in',
            processing_error: 'Processing error',
            try_again: 'Try again',
            watch_btn: 'Watch',
            sending_label: 'Sending...',
            // Ad reward toasts/notifs
            partial_ad_notif: 'Partial ad reward',
            pts_pct_label: 'pts (50%)',
            added_prefix: '+',
            pts_suffix: 'pts',
            watched_prefix: 'Watched',
            ads_today_suffix: 'ads today',
            ad_reward_notif: 'Ad reward',
            pts_added_to_bal: 'pts added to your balance',
            daily_ads_done_toast: 'All ads done! 🏆',
            come_back_tomorrow: 'Come back tomorrow for more points',
            // Daily mission
            mission_reward_title: 'Mission reward ✓',
            already_claimed: 'Already claimed',
            error_occurred: 'Error occurred',
            daily_mission_notif: 'Daily mission reward ✓',
            // Channel tasks
            not_joined_channel: 'Not joined yet ❌',
            click_join_first: 'Click "Join" first',
            already_verified: 'Already verified ✓',
            make_sure_joined: 'Make sure you joined the channel',
            then_retry: 'then try again',
            joined_channel_toast: 'Joined channel! 🎉',
            tg_channel_task_notif: 'Telegram channel task ✓',
            channel_task_notif: 'Channel task ✓',
            channel_hint_text: 'Click "Verify" after joining the channel',
            completed_badge: 'Done',
            max_members: 'max',
            members_suffix: 'members',
            // Referral
            n_friends_badge: 'friends',
            n_more_friends_suffix: 'more friends',
            pending_activation: 'Pending',
            default_username: 'User',
            n_requests_suffix: 'requests',
            // Withdraw history
            withdraw_ton_label: 'TON Withdraw',
            status_completed: 'Completed',
            status_rejected: 'Rejected',
            status_pending: 'Processing',
            // Level / tier
            tier_gold_label: 'Gold Level',
            tier_silver_label: 'Silver Level',
            tier_green_label: 'Green Level',
            level_prefix: 'Level',
            // Home ticker
            ticker_balance: 'Balance',
            ticker_pts: 'pts',
            ticker_level: 'Level',
            ticker_friends: 'Friends',
            ticker_tasks: 'Tasks',
            // Daily gift overlay (JS)
            gift_already_claimed_today: 'Already claimed today ✓',
            gift_claimed_btn: 'Claimed ✓',
            gift_claimed_toast: 'Gift claimed!',
            gift_daily_notif: 'Daily gift ✓',
            pts_added_suffix: 'pts added to your balance',
            // Gift day labels (fallback)
            gift_day_1: 'Day 1',
            gift_day_1_desc: 'Congrats! Come back daily to multiply your rewards!',
            gift_day_2: 'Day 2',
            gift_day_2_desc: 'Two days in a row! Persistence pays off.',
            gift_day_3: 'Day 3',
            gift_day_3_desc: 'Three days in a row!',
            gift_day_4: 'Day 4',
            gift_day_4_desc: 'Your week is almost here!',
            gift_day_5: 'Day 5',
            gift_day_5_desc: 'Five days!',
            gift_day_6: 'Day 6',
            gift_day_6_desc: 'One more day and your week is complete!',
            gift_day_7: 'Day 7',
            gift_day_7_desc: 'A full week! Huge reward.',
            gift_day_prefix: 'Day',
            // TON Withdraw overlay
            submit_withdraw_btn: 'Submit Withdrawal',
            insufficient_balance_err: 'Insufficient balance',
            level_required_prefix: 'Requires level',
            level_required_suffix: 'to withdraw',
            error_try_again: 'Error, please try again',
            withdraw_sent_toast: 'Withdrawal request sent! 🎉',
            withdraw_processing_desc: 'Your request will be processed soon',
            withdraw_ton_notif: 'TON withdrawal request sent',
            pts_processing_suffix: 'pts being processed',
            // Adsgram task
            verify_error: 'Verification error',
            ad_task_done: 'Ad task complete 🎉',
            ad_task_notif: 'Ad task ✓',
            wait_btn: 'Wait',
            restart_app: 'Restart the app',
            session_too_long: 'Session too long',
            task_load_error: 'Task load error',
            try_later: 'Try later',
            // Monetag
            loading_sdk: 'Loading SDK...',
            monetag_loading: 'Loading...',
            monetag_daily_limit_reached: 'Monetag daily limit reached',
            wait_n_sec_prefix: 'Wait',
            connection_error: 'Connection error',
            // Share
            share_msg_text: 'Join me on Arabi Earn and win free points! 🎁',
            copy_svg_label: 'Copy',
            join_channel_btn: 'Subscribe',
            verify_channel_btn: 'Verify',
            left_channel_toast: 'You left channel',
            penalty_pts_prefix: 'Deducted',
            rejoin_to_restore: 'Rejoin to restore the task',
            // Time ago
            time_now: 'just now',
            time_ago_min_fmt: '{n} min ago',
            time_ago_hr_fmt: '{n} hr ago',
            time_ago_day_fmt: '{n} days ago',
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
            toast_ad_pts: 'Мы добавили 50 очков на ваш баланс',
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

            /* ── JS dynamic strings ── */
            // Partial ad notice
            partial_ad_warning: '⚠️ Вам нужно взаимодействовать с рекламой<br>чтобы получить полную награду',
            partial_ad_got: 'Вы получили',
            partial_ad_pts_pct: 'очк. (50%)',
            partial_ad_instead: 'вместо',
            partial_ad_full_pts: 'полных очков',
            partial_ad_ok: 'Понял!',
            // Watch ad flow
            wait_a_moment: 'Подождите',
            seconds_suffix: 'с',
            ad_sdk_failed: 'Реклама не загрузилась',
            check_connection: 'Проверьте соединение',
            ad_loading_label: 'Загрузка рекламы...',
            ad_incomplete: 'Реклама не завершена',
            watch_ad_to_end: 'Смотрите рекламу до конца',
            ad_word: 'Реклама',
            ad_next_after: '✓ — следующая через',
            processing_error: 'Ошибка обработки',
            try_again: 'Попробуйте снова',
            watch_btn: 'Смотреть',
            sending_label: 'Отправка...',
            // Ad reward toasts/notifs
            partial_ad_notif: 'Частичная награда за рекламу',
            pts_pct_label: 'очк. (50%)',
            added_prefix: '+',
            pts_suffix: 'очк.',
            watched_prefix: 'Просмотрено',
            ads_today_suffix: 'реклам сегодня',
            ad_reward_notif: 'Награда за рекламу',
            pts_added_to_bal: 'очков добавлено на баланс',
            daily_ads_done_toast: 'Вся реклама просмотрена! 🏆',
            come_back_tomorrow: 'Вернитесь завтра за очками',
            // Daily mission
            mission_reward_title: 'Награда за задание ✓',
            already_claimed: 'Уже получено',
            error_occurred: 'Произошла ошибка',
            daily_mission_notif: 'Награда за дневное задание ✓',
            // Channel tasks
            not_joined_channel: 'Вы ещё не вступили ❌',
            click_join_first: 'Нажмите «Вступить» сначала',
            already_verified: 'Уже подтверждено ✓',
            make_sure_joined: 'Убедитесь, что вы вступили в канал',
            then_retry: 'затем попробуйте снова',
            joined_channel_toast: 'Вступили в канал! 🎉',
            tg_channel_task_notif: 'Задание канала Telegram ✓',
            channel_task_notif: 'Задание канала ✓',
            channel_hint_text: 'Нажмите «Проверить» после вступления в канал',
            completed_badge: 'Готово',
            max_members: 'макс.',
            members_suffix: 'участников',
            // Referral
            n_friends_badge: 'друзей',
            n_more_friends_suffix: 'других друзей',
            pending_activation: 'Ожидание',
            default_username: 'Пользователь',
            n_requests_suffix: 'запросов',
            // Withdraw history
            withdraw_ton_label: 'Вывод TON',
            status_completed: 'Завершено',
            status_rejected: 'Отклонено',
            status_pending: 'Обработка',
            // Level / tier
            tier_gold_label: 'Золотой уровень',
            tier_silver_label: 'Серебряный уровень',
            tier_green_label: 'Зелёный уровень',
            level_prefix: 'Уровень',
            // Home ticker
            ticker_balance: 'Баланс',
            ticker_pts: 'очк.',
            ticker_level: 'Уровень',
            ticker_friends: 'Друзья',
            ticker_tasks: 'Задания',
            // Daily gift overlay (JS)
            gift_already_claimed_today: 'Уже получено сегодня ✓',
            gift_claimed_btn: 'Получено ✓',
            gift_claimed_toast: 'Подарок получен!',
            gift_daily_notif: 'Ежедневный подарок ✓',
            pts_added_suffix: 'очков добавлено на баланс',
            // Gift day labels (fallback)
            gift_day_1: 'День 1',
            gift_day_1_desc: 'Поздравляем! Заходите ежедневно!',
            gift_day_2: 'День 2',
            gift_day_2_desc: 'Два дня подряд! Настойчивость окупается.',
            gift_day_3: 'День 3',
            gift_day_3_desc: 'Три дня подряд!',
            gift_day_4: 'День 4',
            gift_day_4_desc: 'Ваша неделя близко!',
            gift_day_5: 'День 5',
            gift_day_5_desc: 'Пять дней!',
            gift_day_6: 'День 6',
            gift_day_6_desc: 'Ещё один день и неделя завершена!',
            gift_day_7: 'День 7',
            gift_day_7_desc: 'Полная неделя! Огромная награда.',
            gift_day_prefix: 'День',
            // TON Withdraw overlay
            submit_withdraw_btn: 'Отправить запрос',
            insufficient_balance_err: 'Недостаточно средств',
            level_required_prefix: 'Требуется уровень',
            level_required_suffix: 'для вывода',
            error_try_again: 'Ошибка, попробуйте снова',
            withdraw_sent_toast: 'Запрос на вывод отправлен! 🎉',
            withdraw_processing_desc: 'Ваш запрос будет обработан скоро',
            withdraw_ton_notif: 'Запрос на вывод TON отправлен',
            pts_processing_suffix: 'очков обрабатывается',
            // Adsgram task
            verify_error: 'Ошибка проверки',
            ad_task_done: 'Задание с рекламой выполнено 🎉',
            ad_task_notif: 'Задание с рекламой ✓',
            wait_btn: 'Ждите',
            restart_app: 'Перезапустите приложение',
            session_too_long: 'Слишком длинная сессия',
            task_load_error: 'Ошибка загрузки задания',
            try_later: 'Попробуйте позже',
            // Monetag
            loading_sdk: 'Загрузка SDK...',
            monetag_loading: 'Загрузка...',
            monetag_daily_limit_reached: 'Достигнут дневной лимит Monetag',
            wait_n_sec_prefix: 'Подождите',
            connection_error: 'Ошибка соединения',
            // Share
            share_msg_text: 'Присоединяйся ко мне в Arabi Earn и зарабатывай! 🎁',
            copy_svg_label: 'Копировать',
            join_channel_btn: 'Подписаться',
            verify_channel_btn: 'Проверить',
            left_channel_toast: 'Вы покинули канал',
            penalty_pts_prefix: 'Снято',
            rejoin_to_restore: 'Вступите снова чтобы восстановить задание',
            // Time ago
            time_now: 'только что',
            time_ago_min_fmt: '{n} мин. назад',
            time_ago_hr_fmt: '{n} ч. назад',
            time_ago_day_fmt: '{n} дн. назад',
        }
    };

    let currentLang = 'ar';

    /* ── Global accessor — used by app-ui.js / app-ads.js ── */
    window.T = (key) => (TRANSLATIONS[currentLang] || TRANSLATIONS.ar)[key];

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
