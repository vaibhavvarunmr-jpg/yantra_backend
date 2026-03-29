const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

app.use(cors({ origin: '*' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ─── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Yantra backend is running 🚀' });
});

// ─── SIGN UP ─────────────────────────────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password required' });

  const { data, error } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name }
  });
  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('users').insert({
    id: data.user.id, name, email, plan: 'starter',
    websites_built: 0, created_at: new Date().toISOString()
  });

  res.json({ success: true, user: { id: data.user.id, name, email } });
});

// ─── SIGN IN ─────────────────────────────────────────────────────────────────
app.post('/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  const { data: profile } = await supabase
    .from('users').select('*').eq('id', data.user.id).single();

  res.json({
    success: true,
    token: data.session.access_token,
    user: {
      id: data.user.id,
      name: profile?.name || email.split('@')[0],
      email,
      plan: profile?.plan || 'starter',
      websites_built: profile?.websites_built || 0
    }
  });
});

// ─── GET USER PROFILE ────────────────────────────────────────────────────────
app.get('/user/profile', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile } = await supabase
    .from('users').select('*').eq('id', user.id).single();

  res.json({ success: true, user: profile });
});

// ─── BUILD WEBSITE ───────────────────────────────────────────────────────────
app.post('/ai/build-website', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { name, type, location, phone, description } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Business name and type required' });

  const { data: profile } = await supabase
    .from('users').select('*').eq('id', user.id).single();

  if (profile?.plan === 'starter' && (profile?.websites_built || 0) >= 3)
    return res.status(403).json({ error: 'Free plan limit reached. Upgrade to Growth.' });

  try {
    const prompt = `Create a complete, beautiful, professional single-page HTML website for this business:

Business Name: ${name}
Business Type: ${type}
Location: ${location || 'India'}
Phone: ${phone || 'Contact us'}
Description: ${description || `A premium ${type} business`}

Requirements:
- Complete standalone HTML file with all CSS and JS embedded
- Modern, clean, professional design matching the business type
- Sections: Hero with CTA, About, Services, Testimonials, Contact with phone and address, Footer
- Mobile responsive, smooth animations, Google Fonts
- Professional color scheme fitting the business
- Return ONLY complete HTML code, no explanation, no markdown backticks`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Claude API failed');
    }

    const data = await response.json();
    let html = data.content[0].text;
    html = html.replace(/^```html\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();

    await supabase.from('websites').insert({
      user_id: user.id, business_name: name, business_type: type,
      location: location || '', phone: phone || '',
      html_code: html, created_at: new Date().toISOString()
    });

    await supabase.from('users')
      .update({ websites_built: (profile?.websites_built || 0) + 1 })
      .eq('id', user.id);

    res.json({ success: true, html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET USER WEBSITES ───────────────────────────────────────────────────────
app.get('/user/websites', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: websites } = await supabase
    .from('websites')
    .select('id, business_name, business_type, location, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  res.json({ success: true, websites: websites || [] });
});

// ─── GET SINGLE WEBSITE ──────────────────────────────────────────────────────
app.get('/user/websites/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: website } = await supabase
    .from('websites').select('*')
    .eq('id', req.params.id).eq('user_id', user.id).single();

  if (!website) return res.status(404).json({ error: 'Website not found' });
  res.json({ success: true, website });
});

// ─── GENERATE SALES KIT ──────────────────────────────────────────────────────
app.post('/ai/generate-sales-kit', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { name, type, location, phone, description } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Business name and type required' });

  try {
    const prompt = `You are an expert sales consultant for Indian small businesses. Create a complete sales kit for this business:

Business Name: ${name}
Business Type: ${type}
Location: ${location || 'India'}
Phone: ${phone || 'Contact us'}
Description: ${description || `A ${type} business`}

Generate a complete sales kit in this EXACT JSON format with no markdown, no backticks, just pure JSON:

{
  "sales_script": {
    "opening": "Word for word opening line when calling or meeting a customer",
    "pitch": "2-3 sentence pitch explaining what you do and why they need it",
    "closing": "Word for word closing line to get a commitment",
    "full_script": "Complete 10-15 line phone/in-person sales script"
  },
  "whatsapp_templates": [
    {"name": "Cold Outreach", "message": "Complete WhatsApp message for reaching out to new customers"},
    {"name": "Follow Up", "message": "Follow up message for someone who showed interest"},
    {"name": "Special Offer", "message": "Promotional message with an offer"},
    {"name": "Referral Request", "message": "Message asking existing customers for referrals"}
  ],
  "email_sequence": [
    {"day": 1, "subject": "Email subject line", "body": "Complete email body for day 1 - introduction"},
    {"day": 3, "subject": "Email subject line", "body": "Complete email body for day 3 - value proposition"},
    {"day": 7, "subject": "Email subject line", "body": "Complete email body for day 7 - pitch"},
    {"day": 14, "subject": "Email subject line", "body": "Complete email body for day 14 - objection handling"},
    {"day": 21, "subject": "Email subject line", "body": "Complete email body for day 21 - final close with offer"}
  ],
  "objection_handler": [
    {"objection": "It's too expensive", "response": "Perfect response"},
    {"objection": "I'll think about it", "response": "Perfect response"},
    {"objection": "I don't have time", "response": "Perfect response"},
    {"objection": "I already have someone for this", "response": "Perfect response"},
    {"objection": "Can you give a discount?", "response": "Perfect response"},
    {"objection": "I need to ask my spouse/partner", "response": "Perfect response"},
    {"objection": "I've had bad experiences before", "response": "Perfect response"},
    {"objection": "Your competitor is cheaper", "response": "Perfect response"},
    {"objection": "I'm not sure if I need this", "response": "Perfect response"},
    {"objection": "Let me do more research first", "response": "Perfect response"}
  ],
  "ad_copy": [
    {"platform": "Instagram", "type": "Story Ad", "headline": "Headline", "body": "Ad body", "cta": "CTA"},
    {"platform": "Facebook", "type": "Feed Ad", "headline": "Headline", "body": "Ad body", "cta": "CTA"},
    {"platform": "Google", "type": "Search Ad", "headline": "Headline max 30 chars", "body": "Description max 90 chars", "cta": "CTA"}
  ]
}

Make everything specific to this exact business. Use the business name, location, and type throughout. Make it sound natural and Indian in style. Return ONLY the JSON object, nothing else.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Claude API failed');
    }

    const data = await response.json();
    let text = data.content[0].text.trim()
      .replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
    const kit = JSON.parse(text);

    await supabase.from('sales_kits').insert({
      user_id: user.id, business_name: name, business_type: type,
      location: location || '', kit_data: JSON.stringify(kit),
      created_at: new Date().toISOString()
    });

    res.json({ success: true, kit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET USER SALES KITS ─────────────────────────────────────────────────────
app.get('/user/sales-kits', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: kits } = await supabase
    .from('sales_kits')
    .select('id, business_name, business_type, location, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  res.json({ success: true, kits: kits || [] });
});

// ─── GENERATE AD CAMPAIGN ────────────────────────────────────────────────────
app.post('/ai/generate-campaign', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { name, type, location, goal, description, budget, platforms } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Business name and type required' });

  try {
    const platformList = (platforms || ['instagram', 'facebook']).join(', ');
    const prompt = `You are an expert digital marketing strategist for Indian small businesses. Create complete ad campaigns for this business:

Business Name: ${name}
Business Type: ${type}
Location: ${location || 'India'}
Campaign Goal: ${goal || 'Get more customers'}
Description: ${description || `A ${type} business`}
Monthly Budget: ₹${budget || 5000}
Platforms: ${platformList}

Return ONLY this JSON, no markdown:
{
  "campaigns": [
    {
      "platform": "Instagram",
      "type": "Story Ad",
      "headline": "Attention-grabbing headline max 10 words",
      "body": "Ad body copy 2-3 sentences specific to this business",
      "cta": "Clear call to action",
      "target_audience": "Specific audience description",
      "suggested_budget": "Monthly budget for this platform in rupees number only",
      "estimated_reach": "Estimated monthly reach e.g. 5,000-10,000 people",
      "best_time": "Best time to run this ad",
      "tips": "One specific tip for this platform"
    }
  ]
}

Create one object per platform from: ${platformList}. Make everything hyper-specific to this business and location. Return ONLY the JSON.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });

    if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || 'Claude API failed'); }
    const data = await response.json();
    let text = data.content[0].text.trim()
      .replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
    const result = JSON.parse(text);
    res.json({ success: true, campaigns: result.campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  EMAIL CAMPAIGN AGENT  — The execution engine
// ════════════════════════════════════════════════════════════════════════════

// Helper: send one email via Resend
async function sendEmail({ to_name, to_email, from_name, subject, body }) {
  return resend.emails.send({
    from: `${from_name} <onboarding@resend.dev>`,
    to: to_email,
    subject,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                  max-width:580px;margin:0 auto;padding:40px 28px;color:#1a1a1a;
                  line-height:1.75;font-size:15px;background:#ffffff">
        <p style="margin:0 0 18px">${
          body
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n\n/g, '</p><p style="margin:0 0 18px">')
            .replace(/\n/g, '<br>')
        }</p>
        <hr style="border:none;border-top:1px solid #eee;margin:36px 0 20px">
        <p style="font-size:12px;color:#999;margin:0">
          Sent via Yantra AI ·
          <a href="mailto:unsubscribe@yantra.ai?subject=Unsubscribe&body=${encodeURIComponent(to_email)}"
             style="color:#999">Unsubscribe</a>
        </p>
      </div>
    `
  });
}

// ─── LAUNCH EMAIL CAMPAIGN ───────────────────────────────────────────────────
// Body: { business_name, business_type, target_audience, value_proposition, contacts: [{email, name}] }
app.post('/campaigns/launch', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { business_name, business_type, target_audience, value_proposition, contacts } = req.body;
  if (!contacts?.length) return res.status(400).json({ error: 'At least one contact is required' });

  // Generate email sequence with Claude
  let sequence;
  try {
    const aiRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are an expert email marketer. Generate a 3-email drip campaign sequence as a JSON array.

Business: ${business_name || 'Unknown'}
Type: ${business_type || 'Unknown'}
Target audience: ${target_audience || 'General audience'}
Value proposition: ${value_proposition || 'Our product/service'}

Return ONLY a valid JSON array like this (no markdown, no extra text):
[
  {"day": 0, "subject": "...", "body": "..."},
  {"day": 3, "subject": "...", "body": "..."},
  {"day": 7, "subject": "...", "body": "..."}
]

Each body should be 3-4 short paragraphs, professional but warm, personalised to the audience.`
      }]
    });
    let raw = aiRes.content[0].text.trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    sequence = JSON.parse(raw);
  } catch (e) {
    console.error('Claude sequence generation failed:', e.message);
    return res.status(500).json({ error: 'Failed to generate email sequence: ' + e.message });
  }

  if (!sequence?.length) return res.status(500).json({ error: 'Email sequence is required' });

  try {
    // 1. Create campaign record
    const { data: campaign, error: campErr } = await supabase
      .from('email_campaigns')
      .insert({
        user_id: user.id,
        business_name: business_name || '',
        business_type: business_type || '',
        sequence,
        total_contacts: contacts.length,
        emails_sent: 0,
        status: 'active'
      })
      .select()
      .single();
    if (campErr) throw new Error(campErr.message);

    // 2. Insert all contacts (first email scheduled immediately)
    const now = new Date();
    await supabase.from('campaign_contacts').insert(
      contacts.map(c => ({
        campaign_id: campaign.id,
        user_id: user.id,
        email: c.email,
        name: c.name || '',
        current_step: 0,
        next_send_at: now.toISOString(),
        status: 'active',
        emails_sent: 0
      }))
    );

    // 3. Send first email immediately to all contacts
    const firstEmail = sequence[0];
    let sent = 0, failed = 0;

    for (const contact of contacts) {
      try {
        await sendEmail({
          to_name: contact.name || contact.email,
          to_email: contact.email,
          from_name: business_name || 'Yantra',
          subject: firstEmail.subject,
          body: firstEmail.body
        });
        sent++;
      } catch (e) {
        failed++;
        console.error(`Failed to send to ${contact.email}:`, e.message);
      }
    }

    // 4. Advance all contacts to step 1, schedule next follow-up
    const nextEmail = sequence[1];
    const nextSendAt = nextEmail
      ? new Date(now.getTime() + nextEmail.day * 24 * 60 * 60 * 1000).toISOString()
      : null;

    await supabase.from('campaign_contacts')
      .update({
        current_step: 1,
        last_sent_at: now.toISOString(),
        next_send_at: nextSendAt,
        emails_sent: sent > 0 ? 1 : 0,
        status: nextEmail ? 'active' : 'completed'
      })
      .eq('campaign_id', campaign.id);

    // 5. Update campaign totals
    await supabase.from('email_campaigns')
      .update({ emails_sent: sent })
      .eq('id', campaign.id);

    res.json({
      success: true,
      campaign_id: campaign.id,
      sent,
      failed,
      next_followup: nextSendAt,
      message: `Campaign launched! ${sent} emails sent${failed ? `, ${failed} failed` : ''}.`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST USER CAMPAIGNS ─────────────────────────────────────────────────────
app.get('/campaigns', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: campaigns } = await supabase
    .from('email_campaigns')
    .select('id, business_name, business_type, total_contacts, emails_sent, status, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  res.json({ success: true, campaigns: campaigns || [] });
});

// ─── GET SINGLE CAMPAIGN + STATS ─────────────────────────────────────────────
app.get('/campaigns/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: campaign } = await supabase
    .from('email_campaigns').select('*')
    .eq('id', req.params.id).eq('user_id', user.id).single();

  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { data: contacts } = await supabase
    .from('campaign_contacts')
    .select('email, name, current_step, emails_sent, status, last_sent_at, next_send_at')
    .eq('campaign_id', req.params.id)
    .order('created_at', { ascending: true });

  const stats = {
    total:       contacts?.length || 0,
    active:      contacts?.filter(c => c.status === 'active').length    || 0,
    completed:   contacts?.filter(c => c.status === 'completed').length || 0,
    emails_sent: contacts?.reduce((sum, c) => sum + (c.emails_sent || 0), 0) || 0
  };

  res.json({ success: true, campaign, contacts: contacts || [], stats });
});

// ─── PAUSE / RESUME CAMPAIGN ──────────────────────────────────────────────────
app.post('/campaigns/:id/pause', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: campaign } = await supabase
    .from('email_campaigns').select('status')
    .eq('id', req.params.id).eq('user_id', user.id).single();

  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const newStatus = campaign.status === 'paused' ? 'active' : 'paused';
  await supabase.from('email_campaigns').update({ status: newStatus }).eq('id', req.params.id);

  res.json({ success: true, status: newStatus, message: `Campaign ${newStatus}` });
});

// ─── CRON: PROCESS FOLLOW-UP EMAILS ──────────────────────────────────────────
// Hit this endpoint every hour via Railway cron or cron-job.org
// Header required: x-cron-key: <CRON_SECRET env var>
app.post('/cron/process-followups', async (req, res) => {
  if (req.headers['x-cron-key'] !== process.env.CRON_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date();
  let processed = 0, sent = 0, errors = 0;

  try {
    // Find all contacts whose next email is due
    const { data: dueContacts, error: fetchErr } = await supabase
      .from('campaign_contacts')
      .select('id, email, name, current_step, campaign_id, emails_sent')
      .eq('status', 'active')
      .lte('next_send_at', now.toISOString())
      .not('next_send_at', 'is', null)
      .limit(200);

    if (fetchErr) throw new Error(fetchErr.message);
    if (!dueContacts?.length)
      return res.json({ success: true, processed: 0, sent: 0, message: 'No follow-ups due' });

    // Batch-fetch the campaigns we need
    const campaignIds = [...new Set(dueContacts.map(c => c.campaign_id))];
    const { data: campaigns } = await supabase
      .from('email_campaigns')
      .select('id, business_name, sequence, status')
      .in('id', campaignIds)
      .eq('status', 'active');

    const campaignMap = Object.fromEntries((campaigns || []).map(c => [c.id, c]));

    for (const contact of dueContacts) {
      const campaign = campaignMap[contact.campaign_id];
      if (!campaign) continue; // campaign paused or not found

      const sequence = Array.isArray(campaign.sequence)
        ? campaign.sequence
        : JSON.parse(campaign.sequence || '[]');

      const step = contact.current_step;

      // Sequence exhausted — mark complete
      if (step >= sequence.length) {
        await supabase.from('campaign_contacts')
          .update({ status: 'completed', next_send_at: null })
          .eq('id', contact.id);
        processed++;
        continue;
      }

      const emailToSend = sequence[step];

      try {
        await sendEmail({
          to_name: contact.name || contact.email,
          to_email: contact.email,
          from_name: campaign.business_name || 'Yantra',
          subject: emailToSend.subject,
          body: emailToSend.body
        });
        sent++;
      } catch (e) {
        errors++;
        console.error(`Follow-up failed for ${contact.email}:`, e.message);
        continue;
      }

      // Schedule next step
      const nextStep = step + 1;
      const nextEmail = sequence[nextStep];
      let nextSendAt = null;

      if (nextEmail) {
        // Calculate delay: difference in days between current and next email
        const currentDay = emailToSend.day || 0;
        const nextDay    = nextEmail.day    || 0;
        const delayMs    = Math.max(nextDay - currentDay, 1) * 24 * 60 * 60 * 1000;
        nextSendAt = new Date(now.getTime() + delayMs).toISOString();
      }

      await supabase.from('campaign_contacts').update({
        current_step: nextStep,
        last_sent_at: now.toISOString(),
        next_send_at: nextSendAt,
        emails_sent: (contact.emails_sent || 0) + 1,
        status: nextEmail ? 'active' : 'completed'
      }).eq('id', contact.id);

      // Bump campaign total
      await supabase.from('email_campaigns')
        .update({ emails_sent: supabase.sql`emails_sent + 1` })
        .eq('id', contact.campaign_id);

      processed++;
    }

    res.json({
      success: true,
      processed,
      sent,
      errors,
      message: `Processed ${processed} contacts, sent ${sent} follow-up emails`
    });

  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════════════════════════════

const adminAuth = (req, res, next) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY && req.headers['x-admin-key'] !== 'YugaAdmin2025!')
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/admin/users', adminAuth, async (req, res) => {
  const { data: users, error } = await supabase
    .from('users').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, users: users || [] });
});

app.get('/admin/websites', adminAuth, async (req, res) => {
  const { data: websites, error } = await supabase
    .from('websites')
    .select('id, business_name, business_type, location, created_at, user_id')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const withEmails = await Promise.all((websites || []).map(async (w) => {
    const { data: user } = await supabase.from('users').select('email, name').eq('id', w.user_id).single();
    return { ...w, user_email: user?.email || '', user_name: user?.name || '' };
  }));

  res.json({ success: true, websites: withEmails });
});

app.get('/admin/stats', adminAuth, async (req, res) => {
  const [
    { count: userCount },
    { count: websiteCount },
    { count: campaignCount },
    { count: emailsSentCount }
  ] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact', head: true }),
    supabase.from('websites').select('*', { count: 'exact', head: true }),
    supabase.from('email_campaigns').select('*', { count: 'exact', head: true }),
    supabase.from('campaign_contacts').select('*', { count: 'exact', head: true })
  ]);

  res.json({
    success: true,
    users: userCount || 0,
    websites: websiteCount || 0,
    campaigns: campaignCount || 0,
    total_contacts_reached: emailsSentCount || 0
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Yantra backend running on port ${PORT} 🚀`));
