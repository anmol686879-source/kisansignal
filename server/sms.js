// SMS delivery. Providers: "console" (development only) and "twilio".
export function makeSender(env) {
  const provider = (env.SMS_PROVIDER || 'console').toLowerCase();
  if (provider === 'console') {
    if (env.NODE_ENV === 'production') throw new Error('SMS_PROVIDER=console is not allowed in production. Set SMS_PROVIDER=twilio.');
    return { provider, dev: true, async send(to, body) { console.log(`[sms:console] to ${to}: ${body}`); } };
  }
  if (provider === 'twilio') {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from, TWILIO_MESSAGING_SERVICE_SID: svc } = env;
    if (!sid || !token || !(from || svc)) throw new Error('Twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID).');
    return {
      provider, dev: false,
      async send(to, body) {
        const p = new URLSearchParams({ To: to, Body: body });
        if (svc) p.set('MessagingServiceSid', svc); else p.set('From', from);
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: p, signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`Twilio ${r.status}`);
      },
    };
  }
  throw new Error(`Unknown SMS_PROVIDER "${provider}"`);
}
