require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SOCIAL_DOMAINS = ['instagram.com', 'linkedin.com', 'facebook.com', 'tiktok.com', 'twitter.com', 'x.com'];

app.post('/api/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.json({ success: false, message: 'חסר URL' });

  if (SOCIAL_DOMAINS.some(d => url.includes(d))) {
    return res.json({ success: false, isSocial: true, message: 'רשת חברתית — נדרשת הדבקה ידנית' });
  }

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MrsWolfBot/1.0)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const content = extractText(html);
    res.json({ success: true, content, charCount: content.length });
  } catch (err) {
    res.json({ success: false, message: 'לא ניתן לטעון: ' + err.message });
  }
});

app.post('/api/fetch-fb-ads', async (req, res) => {
  const { pageUrl } = req.body;
  if (!pageUrl) return res.json({ success: false, message: 'חסר URL' });

  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  if (!appId || !appSecret) return res.json({ success: false, message: 'חסרים פרטי Facebook ב-.env' });

  const token = process.env.FB_USER_TOKEN || `${appId}|${appSecret}`;

  try {
    let pageId = extractFbPageId(pageUrl);

    let searchByName = false;
    if (!/^\d+$/.test(pageId)) {
      const r = await fetch(
        `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}?fields=id,name&access_token=${token}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const d = await r.json();
      if (d.error) {
        console.log('[FB page lookup error]', d.error.message);
        searchByName = true;
      } else {
        pageId = d.id;
      }
    }

    const params = searchByName
      ? new URLSearchParams({
          access_token: token,
          search_terms: pageId,
          ad_active_status: 'ACTIVE',
          ad_reached_countries: '["IL"]',
          fields: 'ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,page_name,page_id',
          limit: '10'
        })
      : new URLSearchParams({
          access_token: token,
          search_page_ids: pageId,
          ad_active_status: 'ACTIVE',
          ad_reached_countries: '["IL"]',
          fields: 'ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,page_name',
          limit: '25'
        });

    const adsRes = await fetch(
      `https://graph.facebook.com/v19.0/ads_archive?${params}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const adsData = await adsRes.json();
    if (adsData.error) throw new Error('Facebook: ' + adsData.error.message);

    const ads = adsData.data || [];
    if (!ads.length) return res.json({ success: true, content: '', count: 0 });

    const content = ads.map((ad, i) => {
      const parts = [];
      if (ad.ad_creative_link_titles?.length) parts.push('כותרת: ' + ad.ad_creative_link_titles[0]);
      if (ad.ad_creative_bodies?.length) parts.push(ad.ad_creative_bodies[0]);
      if (ad.ad_creative_link_descriptions?.length) parts.push('תיאור: ' + ad.ad_creative_link_descriptions[0]);
      return `[מודעה ${i + 1}]\n${parts.join('\n')}`;
    }).join('\n\n');

    res.json({ success: true, content, count: ads.length, pageName: ads[0]?.page_name || '' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

function extractFbPageId(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    const idParam = u.searchParams.get('id');
    if (idParam) return idParam;
    const pagesMatch = u.pathname.match(/\/pages\/[^/]+\/(\d+)/);
    if (pagesMatch) return pagesMatch[1];
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || url;
  } catch {
    return url;
  }
}

app.post('/api/analyze', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'חסר ANTHROPIC_API_KEY בקובץ .env' });
  }

  const { icp, marketing, businessName, businessDomain } = req.body;

  const systemPrompt = `אתה אנליסט שיווקי בכיר של Mrs. Wolf — חברה שבונה מסע לקוח שלם לעסקים עם מחזור 1.5M+ ₪.

המתודולוגיה: "קמפיין טוב יוצר הכנסות — לא צמיחה. צמיחה מגיעה מעסק מנוהל היטב מבחינת שיווק, מכירות ותפעול ביחד."

כללי ברזל לניתוח:
1. כל ממצא חייב להתבסס על תוכן ספציפי מהחומר שסופק — ציטוט או תיאור מדויק.
2. השווה ישירות בין השפה שהלקוח האידיאלי משתמש בה לבין השפה שמופיעה בשיווק.
3. ישיר וחד — אם יש פספוס גדול, אומרים את זה בלי לרכך.
4. עברית בלבד. ללא קלישאות. ללא ניסוחי AI.
5. ציונים אמיתיים — לא אינפלציה. 50 זה 50, לא 75.
6. אל תשתמש במונח ICP בשום מקום בתשובה — השתמש תמיד ב"לקוח האידיאלי" או "הלקוח".
7. שים לב לסוג החומר השיווקי: אתר תדמית נמדד אחרת מדף מכירה ספציפי. אתר תדמית אמור לשדר זהות ובידול — לא בהכרח לפנות לכאב ספציפי. דף מכירה נמדד על יכולתו לדבר ישירות לכאב ולטריגר של הלקוח האידיאלי. אם לא צוין סוג — נסה להסיק מהתוכן ותציין זאת בניתוח.
8. בממצא של כל ממד — צטט מילה או משפט קצר ספציפי מהחומר כדוגמה (בגרשיים).`;

  const userPrompt = `## עסק: ${businessName || 'לא צוין'} | תחום: ${businessDomain || 'לא צוין'}

## הלקוח האידיאלי (ICP) — כפי שתיאר בעל העסק

${buildICPText(icp)}

## חומר שיווקי קיים

${buildMarketingText(marketing)}

---

נתח את היישור. החזר JSON בלבד, בלי טקסט נוסף:

{
  "icp_summary": "2-3 משפטים קצרים שמגדירים WHO זה הלקוח האידיאלי — מי הוא, מה הכאב, מה הוא מחפש",
  "overall_score": 72,
  "overall_label": "ניסוח ישיר ומחושב — לא סתם 'יישור בינוני' אלא משפט שמסכם את הבעיה המרכזית",
  "slogan_analysis": {
    "slogan_text": "הסלוגן המדויק כפי שמופיע בחומר, או 'לא זוהה סלוגן' אם לא סופק",
    "verdict": "ניסוח ישיר: הסלוגן עושה מה / מפספס מה ביחס ל-ICP",
    "score": 65,
    "gap": "מה חסר בסלוגן — ספציפי, בשפת ה-ICP"
  },
  "critical_gap": "משפט אחד שמסכם את הפספוס הגדול ביותר — הדבר שאם יתוקן, ישנה הכי הרבה",
  "dimensions": [
    {
      "name": "מסר ותוכן",
      "score": 80,
      "finding": "ממצא ספציפי מהחומר שסופק — ציטוט או תיאור מדויק"
    },
    {
      "name": "שפה וניסוח",
      "score": 55,
      "finding": "השווה: שפת ה-ICP מול שפת השיווק — ספציפי"
    },
    {
      "name": "ערוצים ונוכחות",
      "score": 70,
      "finding": "האם הנוכחות היא היכן שה-ICP נמצא? ספציפי"
    },
    {
      "name": "הצעת הערך",
      "score": 75,
      "finding": "האם ברור מה משתנה בחיי הלקוח? ספציפי"
    },
    {
      "name": "מסע הלקוח",
      "score": 60,
      "finding": "מה קורה אחרי שהלקוח האידיאלי נחשף? האם יש מסלול? ספציפי"
    }
  ],
  "strengths": [
    "חוזק ספציפי ומנומק 1",
    "חוזק ספציפי ומנומק 2"
  ],
  "language_comparison": [
    { "icp_says": "מילה שהלקוח משתמש בה", "marketing_says": "מה שמופיע במקומה בשיווק" },
    { "icp_says": "...", "marketing_says": "..." },
    { "icp_says": "...", "marketing_says": "..." }
  ],
  "gaps": [
    "פספוס 1 — הסבר ספציפי ומה המחיר שלו",
    "פספוס 2 — הסבר ספציפי",
    "פספוס 3 — הסבר ספציפי"
  ],
  "recommendations": [
    {
      "title": "כותרת קצרה — פעולה ספציפית",
      "action": "מה עושים בפועל — ספציפי, עם דוגמה אם רלוונטי"
    },
    {
      "title": "כותרת קצרה",
      "action": "פעולה ספציפית"
    },
    {
      "title": "כותרת קצרה",
      "action": "פעולה ספציפית"
    }
  ]
}`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = msg.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('לא נמצא JSON בתשובה');
    let analysis;
    try {
      analysis = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error('[JSON parse error]', parseErr.message);
      console.error('[Raw response]', raw.substring(0, 500));
      throw new Error('שגיאה בפענוח התשובה — נסי שוב עם פחות תוכן שיווקי');
    }
    res.json({ success: true, analysis });
  } catch (err) {
    console.error('[analyze error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 7000);
}

function buildICPText(icp) {
  const labels = {
    who: 'מי הוא',
    pain: 'הכאב הגדול',
    duration: 'כמה זמן עם הבעיה',
    tried: 'מה ניסה עד היום',
    dream: 'לאן רוצה להגיע',
    trigger: 'מה הטריגר עכשיו',
    blockers: 'מה עוצר אותו',
    channels: 'איפה הוא נמצא',
    language: 'שפה וביטויים ספציפיים'
  };
  return Object.entries(labels)
    .filter(([k]) => icp[k]?.trim())
    .map(([k, label]) => `**${label}:** ${icp[k]}`)
    .join('\n');
}

function buildMarketingText(m) {
  const parts = [];
  if (m.website_url) parts.push(`**אתר (URL):** ${m.website_url}`);
  if (m.website_content) parts.push(`**תוכן האתר:**\n${m.website_content}`);
  if (m.slogan) parts.push(`**סלוגן:** ${m.slogan}`);
  if (m.instagram) parts.push(`**אינסטגרם (Bio + פוסטים):**\n${m.instagram}`);
  if (m.linkedin) parts.push(`**לינקדאין:**\n${m.linkedin}`);
  if (m.facebook) parts.push(`**פייסבוק (אורגני):**\n${m.facebook}`);
  if (m.campaign) parts.push(`**קמפיין ממומן (פייסבוק/אינסטגרם):**\n${m.campaign}`);
  if (m.tiktok) parts.push(`**TikTok:**\n${m.tiktok}`);
  if (m.other) parts.push(`**נוסף:**\n${m.other}`);
  if (m.salespage_url) parts.push(`**דף מכירה (URL):** ${m.salespage_url}`);
  if (m.salespage_content) parts.push(`**תוכן דף מכירה:**\n${m.salespage_content}`);
  if (m.type) parts.push(`**סוג החומר המנותח:** ${m.type}`);
  if (m.context) parts.push(`**הקשר נוסף:** ${m.context}`);
  return parts.join('\n\n---\n\n') || '(לא סופק תוכן שיווקי)';
}

// ─── Chain-Check Tool ──────────────────────────────────────────────────────────

const CHAIN_SECTIONS = [
  {
    id: 'discovery', title: 'שיווק וגילוי',
    questions: [
      { text: 'כשמישהו שמע עלייך וזז לבדוק אותך — מה הוא מוצא?', options: ['נוכחות ברורה בכמה ערוצים עם מסר עקבי', 'יש נוכחות אבל המסר לא עקבי בין הערוצים', 'נוכחות מינימלית — קשה למצוא מידע מספיק'] },
      { text: 'כמה זמן לוקח לאדם שנוחת אצלך להבין מה אתה עושה ולמי?', options: ['שניות — מקבל פידבק של "הבנתי מיד"', 'לרוב מבינים, לפעמים שואלים', 'מבלבל — לא ברור מי הלקוח האידיאלי שלי'] },
      { text: 'האם יש לך הוכחות ספציפיות — מספרים, שמות, תוצאות — בחזית השיווק שלך?', options: ['כן, הוכחות ספציפיות עם מספרים ושמות בפרומיננטיות', 'יש הוכחות אבל כלליות — "לקוחות מרוצים" בלי פרטים', 'מעט — מסתמך על מוניטין ולא על ראיות'] },
      { text: 'יש לך מנגנון שמחזיק מתעניין שלא מוכן לקנות עכשיו?', options: ['כן — רשימת דיוור, ניוזלטר, קהילה שמחממת לאורך זמן', 'יש מנגנון חלקי, לא עקבי', 'לא — מי שלא מוכן עכשיו, אבוד'] },
      { text: 'האם ידוע לך מה הטריגר שגורם לאנשים לפנות דווקא עכשיו, ואתה מדבר עליו ישירות?', options: ['כן — יודע מה הטריגר ומתייחס אליו ישירות בתוכן', 'חלקית — יש מושג כללי אבל לא מנגן עליו מספיק', 'לא ממש — לא בטוח מה גורם לאנשים לפנות דווקא עכשיו'] },
    ]
  },
  {
    id: 'sales', title: 'מעמד המכירה',
    questions: [
      { text: 'מה הלקוח הפוטנציאלי עובר לפני שמגיע למעמד המכירה שלך?', options: ['תהליך ייעודי שמחמם ומסנן: וובינר, מאסטרקלאס, סדרת מיילים, קהילה', 'רואה תוכן ומגיע — לא "קר" לגמרי', 'לרוב מגיע ישירות — המלצה, פנייה ישירה, ללא חימום'] },
      { text: 'יש לך רגע ספציפי במכירה שבו אתה רואה שהלקוח "נדלק" — הטון משתנה, הוא מתחיל לשאול שאלות אחרות, ברור שהוא רוצה?', options: ['כן — יש רגע כזה, אני יודע מה גורם לו, ואני בונה אליו', 'קורה לפעמים, אבל לא בכוונה', 'לא — לא שמתי לב לרגע כזה'] },
      { text: 'מה אחוז הסגירה ממי שהגיע למעמד המכירה שלך?', options: ['מעל 50%', '20%–50%', 'מתחת ל-20%'] },
      { text: 'כשלקוח אומר "יקר לי" — יש לך דרך ספציפית שעובדת?', options: ['כן — יש לי תשובה שמחזירה לערך, ועובדת', 'מנסה להסביר, לפעמים עובד', 'מתקשה עם התנגדויות מחיר'] },
      { text: 'לאחר מעמד המכירה — לקוח שלא רכש, מה קורה?', options: ['יש תהליך: מתי חוזרים, מה אומרים, כמה פעמים', 'לפעמים חוזרים, לא שיטתי', 'ממתינים שיחזור לבד'] },
    ]
  },
  {
    id: 'experience', title: 'חוויה ורגעי וואלה',
    questions: [
      { text: 'מה הלקוח מרגיש ב-24 שעות הראשונות אחרי שרכש?', options: ['מקבל ברכה, מידע, צעד הבא — מרגיש שקיבל החלטה נכונה', 'יש תגובה, אבל אין "חוויה" מיוחדת', 'ממתין לשמוע ממני'] },
      { text: 'יש לך "רגע וואלה" מתוכנן — רגע שבו הלקוח מבין שקיבל יותר ממה שחשב?', options: ['כן — מתוכנן, ידוע, ורוב הלקוחות חווים אותו', 'קורה לפעמים, לא בכוונה', 'לא — לא חשבתי על זה כרגע וואלה מוגדר'] },
      { text: 'הלקוח יודע בכל שלב מה קורה ומה הצעד הבא?', options: ['כן — יש שגרה ברורה, הלקוח לא צריך לשאול', 'לרוב כן, לפעמים לא', 'לקוחות לפעמים שואלים "מה קורה?" — מסמן שמשהו לא עובד'] },
      { text: 'יש "רגע הוכחה ראשונה" — שלב מוקדם שבו הלקוח רואה תוצאה ומרגיש שהשקעה הייתה שווה?', options: ['כן — רגע מוגדר שמחזק את ההחלטה מוקדם בתהליך', 'לפעמים קורה, לא מתוכנן', 'לא — אין רגע כזה מוגדר'] },
      { text: 'כשלקוח מסיים איתך — הוא יוצא עם מה שצריך להמשיך?', options: ['כן — תהליך סיום עם כלים, מסלול, תחושת סיכום', 'נפרדים יפה, אבל אין "ערכה"', 'הקשר פשוט נגמר'] },
    ]
  },
  {
    id: 'ambassadors', title: 'שגרירים וצמיחה',
    questions: [
      { text: 'כמה לקוחות שגמרו איתך הפכו לממליצים פעילים שמביאים לקוחות חדשים?', options: ['הרבה — המלצות מגיעות קבוע מלקוחות קיימים ועבר', 'מדי פעם, לא שיטתי', 'כמעט לא — לא ברור למה'] },
      { text: 'יש לך מנגנון שמזמין לקוחות להמליץ — לא רק ממתין שיקרה?', options: ['כן — תהליך ייעודי, שאלות אחרי סיום, בקשת המלצה', 'לפעמים מבקש, לא שיטתי', 'לא — ממתין שהמלצות יגיעו מעצמן'] },
      { text: 'האם יש שירות או מוצר הבא שהלקוח הקיים יכול לקנות, ואתה מציע אותו באופן פעיל?', options: ['כן — יש מסלול upsell מתוכנן ואני מציע אותו', 'יש אפשרויות, אבל לא מציע שיטתית', 'לא — לא בניתי את זה'] },
      { text: 'הלקוחות הישנים מרגישים שאתה עדיין רואה אותם אחרי שנגמרה העבודה?', options: ['כן — יש שגרת תחזוקת קשר: עדכונים, בדיקות, תשומת לב', 'מדי פעם, לא מסודר', 'לא — הקשר נגמר עם העבודה'] },
      { text: 'כמה לקוחות קיימים ועבר רכשו ממך שירות נוסף?', options: ['הרבה — זה חלק ממה שאני בונה', 'כמה מקרים, לא מתוכנן', 'כמעט לא קורה'] },
    ]
  }
];

const CHAIN_OPTION_SCORES = [5, 3, 1];

function calculateChainScores(answers) {
  const MIN = 5, MAX = 25;
  const scores = {};
  answers.forEach((secAnswers, si) => {
    const total = secAnswers.reduce((sum, ansIdx) => sum + (CHAIN_OPTION_SCORES[ansIdx] ?? 1), 0);
    scores[CHAIN_SECTIONS[si].id] = Math.round((total - MIN) / (MAX - MIN) * 100);
  });
  return scores;
}

app.post('/api/chain-check', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'חסר ANTHROPIC_API_KEY בקובץ .env' });
  }

  const { businessInfo, answers, journeyTypes, touchpoints, salesPageContent, textAnswers } = req.body;
  if (!businessInfo || !answers || answers.length !== 4) {
    return res.status(400).json({ error: 'נתונים חסרים' });
  }

  const scores = calculateChainScores(answers);
  const weakestId = Object.entries(scores).sort(([, a], [, b]) => a - b)[0][0];
  const weakestTitle = CHAIN_SECTIONS.find(s => s.id === weakestId)?.title || weakestId;

  const systemPrompt = `אתה מנתח מסע לקוח בכיר של Mrs. Wolf.

המתודולוגיה: Brown Paper Flow — בניית מסע לקוח שלם. השרשרת: שיווק וגילוי, מעמד המכירה, חוויה ורגעי וואלה, שגרירים וצמיחה. חולייה אחת חלשה — כל השרשרת נפגעת.

מושגים מרכזיים:
- "רגעי וואלה" — רגעים שבהם לקוח מרגיש "זה בשבילי" או "קיבלתי יותר ממה שחשבתי"
- "דף מוכיח ולא מבטיח" — הוכחות ספציפיות, מספרים, שמות. לא הבטחות ריקות.
- "לקוח חסיד" — לקוח שהפך לשגריר פעיל
- "Do it right the first time" — בניית מסע לקוח נכון מהתחלה

כללים:
1. ישיר. אם יש בעיה, אומרים אותה.
2. עברית בלבד. ללא קלישאות. ללא ניסוחי AI.
3. כל המלצה ספציפית — לא "שפר את השיווק" אלא מה בדיוק לשנות ואיך.
4. בסס ממצאים על התשובות שסופקו.
5. אל תשתמש ב"ליד" — תמיד "לקוח פוטנציאלי" או "לקוח".
6. אין מקף ארוך בתשובה. משפטים קצרים.`;

  const { name = '', domain = '', description = '', revenue = '' } = businessInfo;
  const journeyTypesText = Array.isArray(journeyTypes) && journeyTypes.length ? journeyTypes.join(', ') : 'לא צוין';
  const touchpointsText = Array.isArray(touchpoints) && touchpoints.length ? touchpoints.join(', ') : 'לא צוין';

  const answeredLines = answers.map((secAnswers, si) => {
    const section = CHAIN_SECTIONS[si];
    const sectionScore = scores[section.id];
    const lines = secAnswers.map((ansIdx, qi) => {
      const q = section.questions[qi];
      return `ש: ${q.text}\nת: ${q.options[ansIdx] || '?'}`;
    }).join('\n\n');
    return `### ${section.title} (ציון: ${sectionScore}/100)\n\n${lines}`;
  }).join('\n\n---\n\n');

  const contextLines = [];
  if (textAnswers?.salesTrigger) contextLines.push(`מה גרם ללקוחות לפנות דווקא עכשיו (בדבריו): ${textAnswers.salesTrigger}`);
  if (textAnswers?.vahaMemory) contextLines.push(`הרגע שלקוחות הכי נזכרים בו: ${textAnswers.vahaMemory}`);

  const salesPageSection = salesPageContent
    ? `\n## תוכן דף המכירה\n${salesPageContent.slice(0, 3000)}\n`
    : '';

  const salesPageNoteInstruction = salesPageContent
    ? '"תובנה אחת ספציפית על דף המכירה — מה חזק ומה חסר"'
    : 'null';

  const userPrompt = `## עסק: ${name || 'לא צוין'} | תחום: ${domain || 'לא צוין'}
${description ? `תיאור: ${description}\n` : ''}${revenue ? `מחזור: ${revenue}\n` : ''}
## מבנה מסע הלקוח בעסק
סוגי מסעות: ${journeyTypesText}
מעמדי מכירה קיימים: ${touchpointsText}
${contextLines.length ? '\n## הקשר נוסף\n' + contextLines.join('\n') + '\n' : ''}${salesPageSection}
## תשובות השאלון

${answeredLines}

---

החולייה החלשה שזוהתה: ${weakestTitle} (${scores[weakestId]}/100)

החזר JSON בלבד, בלי טקסט נוסף:

{
  "critical_insight": "משפט אחד שתופס את הבעיה המרכזית. ספציפי לתשובות. ישיר.",
  "sales_page_note": ${salesPageNoteInstruction},
  "pillar_analysis": {
    "discovery": {
      "headline": "אבחנה ישירה — מה המצב בשיווק וגילוי",
      "finding": "2-3 משפטים ספציפיים לתשובות"
    },
    "sales": {
      "headline": "אבחנה ישירה — מה המצב במעמד המכירה",
      "finding": "2-3 משפטים ספציפיים"
    },
    "experience": {
      "headline": "אבחנה ישירה — מה המצב בחוויה ורגעי וואלה",
      "finding": "2-3 משפטים ספציפיים"
    },
    "ambassadors": {
      "headline": "אבחנה ישירה — מה המצב בשגרירים וצמיחה",
      "finding": "2-3 משפטים ספציפיים"
    }
  },
  "recommendations": [
    {
      "title": "כותרת הפעולה — קצרה וספציפית",
      "action": "מה עושים בפועל. ספציפי, ישים, מבוסס על הבעיה שזוהתה."
    },
    { "title": "...", "action": "..." },
    { "title": "...", "action": "..." }
  ]
}`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = msg.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('לא נמצא JSON בתשובה');
    let analysis;
    try {
      analysis = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error('[chain-check JSON parse error]', parseErr.message);
      throw new Error('שגיאה בפענוח התשובה — נסו שוב');
    }
    res.json({ success: true, scores, analysis });
  } catch (err) {
    console.error('[chain-check error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Email / Summary ──────────────────────────────────────────────────────────

function buildSummaryEmail({ contactInfo, businessInfo, scores, analysis, journeyTypes, touchpoints, answers, textAnswers }) {
  const sectionNames = { discovery: 'שיווק וגילוי', sales: 'מעמד המכירה', experience: 'חוויה ורגעי וואלה', ambassadors: 'שגרירים וצמיחה' };
  const scoreColor = s => s < 40 ? '#d94444' : s < 60 ? '#d47a25' : s < 75 ? '#b89e10' : '#3a9458';

  const scoreRows = Object.entries(scores || {}).map(([id, score]) =>
    `<tr>
      <td style="padding:5px 10px;border:1px solid #e0e0e0">${sectionNames[id] || id}</td>
      <td style="padding:5px 10px;border:1px solid #e0e0e0;color:${scoreColor(score)};font-weight:700">${score}/100</td>
    </tr>`
  ).join('');

  const pillarHtml = Object.entries(analysis?.pillar_analysis || {}).map(([id, p]) =>
    `<div style="margin-bottom:14px">
      <strong>${sectionNames[id] || id}</strong><br>
      ${p.headline || ''}<br>
      <span style="color:#666;font-size:13px">${p.finding || ''}</span>
    </div>`
  ).join('');

  const recsHtml = (analysis?.recommendations || []).map((r, i) =>
    `<div style="margin-bottom:10px">
      <strong>${i + 1}. ${r.title}</strong><br>
      <span style="color:#444;font-size:13px">${r.action}</span>
    </div>`
  ).join('');

  const answersHtml = CHAIN_SECTIONS.map((sec, si) =>
    `<div style="margin-bottom:14px">
      <strong style="color:#555">${sec.title}</strong>
      <table style="width:100%;border-collapse:collapse;margin-top:4px;font-size:12px">
        ${(answers?.[si] || []).map((ansIdx, qi) =>
          `<tr>
            <td style="padding:3px 8px;border:1px solid #eee;color:#888;width:55%">${sec.questions[qi]?.text || ''}</td>
            <td style="padding:3px 8px;border:1px solid #eee">${sec.questions[qi]?.options[ansIdx] || ''}</td>
          </tr>`
        ).join('')}
      </table>
    </div>`
  ).join('');

  const dateStr = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });

  return `<!DOCTYPE html>
<html dir="rtl">
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a;direction:rtl">
  <div style="background:#e85c52;color:white;padding:20px 24px;border-radius:8px 8px 0 0">
    <div style="font-size:11px;opacity:.75;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase">Mrs. Wolf Chain Check</div>
    <h2 style="margin:0 0 4px;font-size:20px">${businessInfo?.name || 'לקוח חדש'} — ${businessInfo?.domain || ''}</h2>
    <div style="font-size:12px;opacity:.8">${dateStr}</div>
    ${contactInfo.wantsCall ? `<div style="display:inline-block;background:white;color:#e85c52;padding:3px 14px;border-radius:20px;margin-top:10px;font-weight:700;font-size:13px">מעוניין/ת בשיחה</div>` : ''}
  </div>
  <div style="border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;padding:20px 24px">
    <table style="width:100%;border-collapse:collapse;background:#f9f9f9;margin-bottom:16px">
      <tr><td style="padding:7px 12px;font-size:13px"><strong>מייל</strong></td><td style="padding:7px 12px;font-size:13px" dir="ltr">${contactInfo.email}</td></tr>
      <tr style="background:#f0f0f0"><td style="padding:7px 12px;font-size:13px"><strong>טלפון</strong></td><td style="padding:7px 12px;font-size:13px" dir="ltr">${contactInfo.phone || 'לא הוזן'}</td></tr>
      <tr><td style="padding:7px 12px;font-size:13px"><strong>שיחה</strong></td><td style="padding:7px 12px;font-size:13px;${contactInfo.wantsCall ? 'color:#e85c52;font-weight:700' : ''}">${contactInfo.wantsCall ? 'כן, מעוניין/ת' : 'לא ציין'}</td></tr>
      ${businessInfo?.revenue ? `<tr style="background:#f0f0f0"><td style="padding:7px 12px;font-size:13px"><strong>מחזור</strong></td><td style="padding:7px 12px;font-size:13px">${businessInfo.revenue}</td></tr>` : ''}
    </table>
    ${businessInfo?.description ? `<p style="font-size:14px;color:#555;margin:0 0 10px">${businessInfo.description}</p>` : ''}
    ${journeyTypes?.length ? `<p style="font-size:12px;color:#888;margin:3px 0">מסעות: ${journeyTypes.join(', ')}</p>` : ''}
    ${touchpoints?.length ? `<p style="font-size:12px;color:#888;margin:3px 0 14px">מעמדי מכירה: ${touchpoints.join(', ')}</p>` : ''}
    <hr style="border:none;border-top:1px solid #eee;margin:14px 0">
    <h3 style="color:#e85c52;font-size:14px;margin:0 0 8px">ציונים</h3>
    <table style="border-collapse:collapse">${scoreRows}</table>
    <hr style="border:none;border-top:1px solid #eee;margin:14px 0">
    <h3 style="color:#e85c52;font-size:14px;margin:0 0 8px">הפספוס המרכזי</h3>
    <div style="background:#fff0ef;border-right:3px solid #e85c52;padding:10px 14px;font-size:14px;line-height:1.5">${analysis?.critical_insight || ''}</div>
    ${analysis?.sales_page_note ? `<hr style="border:none;border-top:1px solid #eee;margin:14px 0"><h3 style="color:#e85c52;font-size:14px;margin:0 0 8px">דף המכירה</h3><p style="font-size:14px">${analysis.sales_page_note}</p>` : ''}
    <hr style="border:none;border-top:1px solid #eee;margin:14px 0">
    <h3 style="color:#e85c52;font-size:14px;margin:0 0 10px">ניתוח לפי עמוד</h3>
    ${pillarHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:14px 0">
    <h3 style="color:#e85c52;font-size:14px;margin:0 0 10px">המלצות</h3>
    ${recsHtml}
    ${textAnswers?.salesTrigger || textAnswers?.vahaMemory ? `<hr style="border:none;border-top:1px solid #eee;margin:14px 0"><h3 style="color:#e85c52;font-size:14px;margin:0 0 8px">הקשר מבעל העסק</h3>${textAnswers.salesTrigger ? `<p style="font-size:13px"><strong>התנגדות מחיר:</strong> ${textAnswers.salesTrigger}</p>` : ''}${textAnswers.vahaMemory ? `<p style="font-size:13px"><strong>רגע הוואלה:</strong> ${textAnswers.vahaMemory}</p>` : ''}` : ''}
    <hr style="border:none;border-top:1px solid #eee;margin:14px 0">
    <h3 style="color:#aaa;font-size:12px;margin:0 0 10px">תשובות השאלון</h3>
    ${answersHtml}
  </div>
</body>
</html>`;
}

app.post('/api/send-summary', async (req, res) => {
  const { contactInfo, businessInfo, scores, analysis, answers, journeyTypes, touchpoints, textAnswers } = req.body;
  if (!contactInfo?.email) return res.status(400).json({ error: 'חסר מייל' });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn('[send-summary] RESEND_API_KEY not set — skipping email');
    return res.json({ success: true, skipped: true });
  }

  const bizName = businessInfo?.name || 'לקוח חדש';
  const callFlag = contactInfo.wantsCall ? ' [מעוניין/ת בשיחה]' : '';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Chain Check <onboarding@resend.dev>',
        to: ['noa@noadoron.co.il'],
        subject: `Chain Check: ${bizName}${callFlag}`,
        html: buildSummaryEmail({ contactInfo, businessInfo, scores, analysis, answers, journeyTypes, touchpoints, textAnswers })
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `Resend error ${resp.status}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[send-summary error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Server ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log(`\n  Mrs. Wolf ICP Tool     http://localhost:${PORT}`);
  console.log(`  Mrs. Wolf Chain Check  http://localhost:${PORT}/chain-check/\n`);
});
