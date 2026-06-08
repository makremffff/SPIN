// ════════════════════════════════════════════════
//  app-i18n.js  —  نظام الترجمة الديناميكي
//  الدعم: عربي | English | Русский
// ════════════════════════════════════════════════

const TRANSLATIONS = {
  ar: {
    // ── شاشة اختيار اللغة
    lang_screen_title:      'اختر لغتك',
    lang_screen_sub:        'يمكنك تغييرها لاحقاً من الإعدادات',

    // ── شاشة التحميل
    loading_text:           'جاري التحميل...',

    // ── بانر الاتصال
    offline_msg:            '📵 أنت غير متصل بالإنترنت — سيتم إعادة الاتصال تلقائياً',

    // ── الصفحة الرئيسية
    user_greeting:          'مرحباً بعودتك',
    balance_label:          'الرصيد الكلي',
    pts:                    'USDT',
    tickets_label:          'تذاكري',
    ticket_unit:            'تذكرة',
    rank_label:             'الترتيب',
    friends_label:          'صديق مدعو',
    tasks_done_label:       'مهمة منجزة',
    total_earned_label:     'إجمالي المكتسب',
    charge_btn:             'شحن',
    withdraw_btn:           'سحب',

    // ── صفحة المهام
    tasks_hero_p:           'أكمل المهام واجمع مكافآتك اليومية',
    our_channel:            'قناتنا الرسمية',
    exclusive_badge:        'حصري',
    ad_tasks_label:         'مهام إعلانية',
    ad_task_name:           'مهمة إعلانية',
    today:                  'اليوم',
    loading_short:          'جاري...',
    completed:              'اكتمل',
    start_btn:              'ابدأ',
    verify_btn:             'تحقق...',
    done_label:             'تم',
    daily_tasks_section_lbl:'المهام اليومية',
    task_watch_10:          'شاهد 10 إعلانات اليوم',
    task_watch_10_of:       'من أصل 10 إعلانات',
    task_watch_25:          'شاهد 25 إعلاناً',
    task_watch_25_of:       'من أصل 25 إعلاناً',
    task_invite_3:          'ادعُ 3 أصدقاء',
    task_invite_3_of:       'من أصل 3 أصدقاء',
    collect_btn:            'جمع',
    add_channel_btn:        'أضف قناتك',
    add_channel_sub:        'اربح من كل مشترك جديد',

    // ── صفحة الربح
    earn_title:             'الربح',
    watch_btn:              'شاهد',
    tickets_today:          'تذاكر اليوم',
    ads_watched:            'إعلان شوهد',
    daily_limit:            'الحد اليومي',
    all_done_title:         'أحسنت! انتهيت من كل الإعلانات',
    all_done_sub:           'عد غداً للحصول على إعلانات جديدة',
    earn_more_label:        'اكسب أكثر',
    weekly_badge:           'أسبوعي',
    invite_btn_title:       'دعوة الأصدقاء',
    invite_btn_sub:         'ادعُ واربح معاً',
    contests:               'المسابقة الأسبوعية',
    contests_sub:           'تنافس على جوائز كبرى',
    gift_title:             'مكافأة يومية',
    gift_sub:               'استلم هديتك الآن',
    daily:                  'يومي',
    coming_soon:            'قريباً',
    achievements:           'الإنجازات',
    achievements_sub:       'اكسب شارات مميزة',
    soon:                   'قريباً',
    available_badge:        'متاح',

    // ── صفحة الدعوة
    invite_page_title:      'ادعُ أصدقاءك',
    invite_hero_title:      'اربح مع أصدقائك',
    invite_hero_sub:        'احصل على مكافأة مقابل كل دعوة',
    your_ref_link:          'رابط دعوتك',
    copy_btn_text:          'نسخ',
    telegram_share:         'تيليغرام',
    whatsapp_share:         'واتساب',
    ref_join_reward:        'مكافأة انضمام الصديق',
    instant_badge:          'فوري',
    ref_ads_share:          'من أرباح إعلانات صديقك',
    ref_pct:                '25% دائماً',
    ongoing_badge:          'مستمر',
    total_referrals:        'إجمالي الدعوات',
    earned_from_refs:       'مكتسب من الدعوات',
    invited_friends_title:  'الأصدقاء المدعوون',
    no_friends_yet:         'لا يوجد أصدقاء مدعوون بعد',
    share_link_hint:        'شارك رابطك وابدأ الكسب معاً',

    // ── صفحة السحب
    balance_available:      'الرصيد المتاح',
    withdraw_methods_title: 'طرق السحب',
    withdraw_history_title: 'سجل السحب',
    no_transactions:        'لا توجد معاملات',
    no_tx_sub:              'ستظهر هنا بعد أول سحب',
    min_label:              'الحد الأدنى',
    ton_wallet:             'محفظة TON',
    paypal_name:            'باي بال',
    fawry_name:             'فوري',

    // ── الصفحة الاجتماعية
    social_promo_title:     'هل تريد الترويج لمنتجك؟',
    social_promo_sub:       'أضف مهمتك الخاصة على منصتك المفضلة وحدد المكافأة للمستخدمين',
    facebook:               'فيسبوك',
    twitter:                'تويتر',
    tiktok:                 'تيكتوك',
    youtube:                'يوتيوب',
    instagram:              'انستغرام',
    contact_dev:            'تواصل مع المطور',
    available_tasks:        'المهام المتاحة',
    nav_social:             'تواصل',

    // ── المسابقة
    comp_subtitle:          'قم بجمع تذاكر وكن انت الرابح',
    time_remaining:         'الوقت المتبقي',
    day_unit:               'يوم',
    hour_unit:              'ساعة',
    minute_unit:            'دقيقة',
    second_unit:            'ثانية',
    top_leaders:            'المتصدرون',
    rest_leaders:           'باقي المتصدرين',

    // ── نافذة سحب TON
    ton_withdraw_title:     'سحب TON',
    first_withdraw_title:   'عرض السحب الأول!',
    first_withdraw_sub:     'الحد الأدنى لأول سحبة',
    first_withdraw_note:    'USDT فقط — بدون متطلب مستوى',
    your_avail_balance:     'رصيدك المتاح',
    min_chip_label:         'الحد الأدنى',
    conversion_rate:        'معدل التحويل',
    ton_address_label:      'عنوان محفظة TON',
    ton_address_error:      'الرجاء إدخال عنوان محفظة TON صحيح',
    submit_withdraw:        'إرسال طلب السحب',

    // ── الإشعارات
    notifications_title:    'الإشعارات',
    no_notifs:              'لا توجد إشعارات بعد',

    // ── الإعدادات
    settings_title:         'الإعدادات',
    settings_lang_label:    'اللغة',

    // ── هدية يومية
    gift_claim_btn:         'استلم',
    gift_preparing:         'جاري تحضير هديتك...',

    // ── أوفرلاي الإعلان
    ad_loading:             'جاري تحميل الإعلان...',

    // ── التنقل
    nav_home:               'الرئيسية',
    nav_earn:               'اكسب',
    nav_tasks:              'المهام',
    nav_withdraw:           'السحب',
  },

  en: {
    lang_screen_title:      'Choose your language',
    lang_screen_sub:        'You can change it later in settings',
    loading_text:           'Loading...',
    offline_msg:            '📵 You are offline — reconnecting automatically',

    user_greeting:          'Welcome back',
    balance_label:          'Total Balance',
    pts:                    'USDT',
    tickets_label:          'My Tickets',
    ticket_unit:            'ticket',
    rank_label:             'Rank',
    friends_label:          'Friend invited',
    tasks_done_label:       'Task completed',
    total_earned_label:     'Total Earned',
    charge_btn:             'Deposit',
    withdraw_btn:           'Withdraw',

    tasks_hero_p:           'Complete tasks and collect your daily rewards',
    our_channel:            'Our Official Channel',
    exclusive_badge:        'Exclusive',
    ad_tasks_label:         'Ad Tasks',
    ad_task_name:           'Ad Task',
    today:                  'today',
    loading_short:          'Loading...',
    completed:              'Completed',
    start_btn:              'Start',
    verify_btn:             'Verifying...',
    done_label:             'Done',
    daily_tasks_section_lbl:'Daily Tasks',
    task_watch_10:          'Watch 10 ads today',
    task_watch_10_of:       'out of 10 ads',
    task_watch_25:          'Watch 25 ads',
    task_watch_25_of:       'out of 25 ads',
    task_invite_3:          'Invite 3 friends',
    task_invite_3_of:       'out of 3 friends',
    collect_btn:            'Claim',
    add_channel_btn:        'Add Your Channel',
    add_channel_sub:        'Earn from every new subscriber',

    earn_title:             'Earn',
    watch_btn:              'Watch',
    tickets_today:          "Today's Tickets",
    ads_watched:            'Ad watched',
    daily_limit:            'Daily limit',
    all_done_title:         "Great! You've watched all ads",
    all_done_sub:           'Come back tomorrow for new ads',
    earn_more_label:        'Earn More',
    weekly_badge:           'Weekly',
    invite_btn_title:       'Invite Friends',
    invite_btn_sub:         'Invite & earn together',
    contests:               'Weekly Contest',
    contests_sub:           'Compete for big prizes',
    gift_title:             'Daily Reward',
    gift_sub:               'Claim your gift now',
    daily:                  'Daily',
    coming_soon:            'Coming Soon',
    achievements:           'Achievements',
    achievements_sub:       'Earn special badges',
    soon:                   'Soon',
    available_badge:        'Available',

    invite_page_title:      'Invite Friends',
    invite_hero_title:      'Earn with Friends',
    invite_hero_sub:        'Get a reward for every invite',
    your_ref_link:          'Your Referral Link',
    copy_btn_text:          'Copy',
    telegram_share:         'Telegram',
    whatsapp_share:         'WhatsApp',
    ref_join_reward:        'Friend Join Reward',
    instant_badge:          'Instant',
    ref_ads_share:          "From your friend's ad earnings",
    ref_pct:                '25% always',
    ongoing_badge:          'Ongoing',
    total_referrals:        'Total Referrals',
    earned_from_refs:       'Earned from Referrals',
    invited_friends_title:  'Invited Friends',
    no_friends_yet:         'No invited friends yet',
    share_link_hint:        'Share your link and start earning together',

    balance_available:      'Available Balance',
    withdraw_methods_title: 'Withdrawal Methods',
    withdraw_history_title: 'Withdrawal History',
    no_transactions:        'No transactions yet',
    no_tx_sub:              'They will appear here after your first withdrawal',
    min_label:              'Minimum',
    ton_wallet:             'TON Wallet',
    paypal_name:            'PayPal',
    fawry_name:             'Fawry',

    social_promo_title:     'Want to promote your product?',
    social_promo_sub:       'Add your own task on your favorite platform and set the reward for users',
    facebook:               'Facebook',
    twitter:                'Twitter',
    tiktok:                 'TikTok',
    youtube:                'YouTube',
    instagram:              'Instagram',
    contact_dev:            'Contact Developer',
    available_tasks:        'Available Tasks',
    nav_social:             'Social',

    comp_subtitle:          'Collect tickets and be the winner',
    time_remaining:         'Time Remaining',
    day_unit:               'day',
    hour_unit:              'hour',
    minute_unit:            'min',
    second_unit:            'sec',
    top_leaders:            'Top Leaders',
    rest_leaders:           'Other Leaders',

    ton_withdraw_title:     'Withdraw TON',
    first_withdraw_title:   'First Withdrawal Offer!',
    first_withdraw_sub:     'Minimum for first withdrawal',
    first_withdraw_note:    'USDT only — no level required',
    your_avail_balance:     'Your Available Balance',
    min_chip_label:         'Minimum',
    conversion_rate:        'Conversion Rate',
    ton_address_label:      'TON Wallet Address',
    ton_address_error:      'Please enter a valid TON wallet address',
    submit_withdraw:        'Submit Withdrawal Request',

    notifications_title:    'Notifications',
    no_notifs:              'No notifications yet',
    settings_title:         'Settings',
    settings_lang_label:    'Language',

    gift_claim_btn:         'Claim',
    gift_preparing:         'Preparing your gift...',
    ad_loading:             'Loading ad...',

    nav_home:               'Home',
    nav_earn:               'Earn',
    nav_tasks:              'Tasks',
    nav_withdraw:           'Withdraw',
  },

  ru: {
    lang_screen_title:      'Выберите язык',
    lang_screen_sub:        'Вы можете изменить это позже в настройках',
    loading_text:           'Загрузка...',
    offline_msg:            '📵 Нет подключения — переподключение...',

    user_greeting:          'Добро пожаловать',
    balance_label:          'Общий баланс',
    pts:                    'USDT',
    tickets_label:          'Мои билеты',
    ticket_unit:            'билет',
    rank_label:             'Место',
    friends_label:          'Приглашённый друг',
    tasks_done_label:       'Выполненных задач',
    total_earned_label:     'Всего заработано',
    charge_btn:             'Пополнить',
    withdraw_btn:           'Вывести',

    tasks_hero_p:           'Выполняйте задания и собирайте ежедневные награды',
    our_channel:            'Наш официальный канал',
    exclusive_badge:        'Эксклюзив',
    ad_tasks_label:         'Рекламные задания',
    ad_task_name:           'Рекламное задание',
    today:                  'сегодня',
    loading_short:          'Загрузка...',
    completed:              'Завершено',
    start_btn:              'Начать',
    verify_btn:             'Проверка...',
    done_label:             'Готово',
    daily_tasks_section_lbl:'Ежедневные задания',
    task_watch_10:          'Посмотри 10 реклам сегодня',
    task_watch_10_of:       'из 10 реклам',
    task_watch_25:          'Посмотри 25 реклам',
    task_watch_25_of:       'из 25 реклам',
    task_invite_3:          'Пригласи 3 друзей',
    task_invite_3_of:       'из 3 друзей',
    collect_btn:            'Получить',
    add_channel_btn:        'Добавить канал',
    add_channel_sub:        'Зарабатывай с каждого подписчика',

    earn_title:             'Заработок',
    watch_btn:              'Смотреть',
    tickets_today:          'Билеты сегодня',
    ads_watched:            'Реклам просмотрено',
    daily_limit:            'Дневной лимит',
    all_done_title:         'Отлично! Все реклам просмотрены',
    all_done_sub:           'Возвращайтесь завтра за новыми',
    earn_more_label:        'Зарабатывай больше',
    weekly_badge:           'Еженедельно',
    invite_btn_title:       'Пригласить друзей',
    invite_btn_sub:         'Приглашай и зарабатывай',
    contests:               'Еженедельный конкурс',
    contests_sub:           'Соревнуйся за большие призы',
    gift_title:             'Ежедневная награда',
    gift_sub:               'Получи свой подарок',
    daily:                  'Ежедневно',
    coming_soon:            'Скоро',
    achievements:           'Достижения',
    achievements_sub:       'Зарабатывай значки',
    soon:                   'Скоро',
    available_badge:        'Доступно',

    invite_page_title:      'Пригласить друзей',
    invite_hero_title:      'Зарабатывай с друзьями',
    invite_hero_sub:        'Получай награду за каждое приглашение',
    your_ref_link:          'Ваша реферальная ссылка',
    copy_btn_text:          'Копировать',
    telegram_share:         'Telegram',
    whatsapp_share:         'WhatsApp',
    ref_join_reward:        'Награда за приглашение',
    instant_badge:          'Мгновенно',
    ref_ads_share:          'С рекламного дохода друга',
    ref_pct:                '25% всегда',
    ongoing_badge:          'Постоянно',
    total_referrals:        'Всего рефералов',
    earned_from_refs:       'Заработано с рефералов',
    invited_friends_title:  'Приглашённые друзья',
    no_friends_yet:         'Пока нет приглашённых',
    share_link_hint:        'Поделись ссылкой и зарабатывай вместе',

    balance_available:      'Доступный баланс',
    withdraw_methods_title: 'Методы вывода',
    withdraw_history_title: 'История вывода',
    no_transactions:        'Нет транзакций',
    no_tx_sub:              'Появится после первого вывода',
    min_label:              'Минимум',
    ton_wallet:             'TON Кошелёк',
    paypal_name:            'PayPal',
    fawry_name:             'Fawry',

    social_promo_title:     'Хотите рекламировать продукт?',
    social_promo_sub:       'Добавь задание на любой платформе и укажи награду для пользователей',
    facebook:               'Facebook',
    twitter:                'Twitter',
    tiktok:                 'TikTok',
    youtube:                'YouTube',
    instagram:              'Instagram',
    contact_dev:            'Связаться с разработчиком',
    available_tasks:        'Доступные задания',
    nav_social:             'Соц. сети',

    comp_subtitle:          'Собирай билеты и стань победителем',
    time_remaining:         'Осталось времени',
    day_unit:               'день',
    hour_unit:              'час',
    minute_unit:            'мин',
    second_unit:            'сек',
    top_leaders:            'Лидеры',
    rest_leaders:           'Другие лидеры',

    ton_withdraw_title:     'Вывод TON',
    first_withdraw_title:   'Первый вывод!',
    first_withdraw_sub:     'Минимум для первого вывода',
    first_withdraw_note:    'USDT — без уровня',
    your_avail_balance:     'Доступный баланс',
    min_chip_label:         'Минимум',
    conversion_rate:        'Курс обмена',
    ton_address_label:      'Адрес кошелька TON',
    ton_address_error:      'Введите корректный адрес кошелька TON',
    submit_withdraw:        'Отправить запрос на вывод',

    notifications_title:    'Уведомления',
    no_notifs:              'Уведомлений пока нет',
    settings_title:         'Настройки',
    settings_lang_label:    'Язык',

    gift_claim_btn:         'Получить',
    gift_preparing:         'Подготовка подарка...',
    ad_loading:             'Загрузка рекламы...',

    nav_home:               'Главная',
    nav_earn:               'Заработок',
    nav_tasks:              'Задания',
    nav_withdraw:           'Вывод',
  }
};

// اللغة الافتراضية
let _currentLang = 'ar';

/** إرجاع ترجمة مفتاح */
export function t(key) {
  return (TRANSLATIONS[_currentLang] || TRANSLATIONS['ar'])[key] || key;
}

/** تطبيق الترجمات على كل عناصر data-i18n */
export function applyTranslations(lang) {
  _currentLang = lang || 'ar';
  localStorage.setItem('app_lang', _currentLang);

  const isRTL = (_currentLang === 'ar');
  document.documentElement.lang = _currentLang;
  document.documentElement.dir  = isRTL ? 'rtl' : 'ltr';

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val) el.textContent = val;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });
}

/** قراءة اللغة المحفوظة */
export function getSavedLang() {
  return localStorage.getItem('app_lang') || null;
}

/** تعيين اللغة الحالية بدون تطبيق */
export function setCurrentLang(lang) {
  _currentLang = lang || 'ar';
}
