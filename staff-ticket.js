/**
 * Staff ticket: the email a restaurant prints and works from.
 *
 * Designed for paper: black on white, no colors, banners, cards or emojis,
 * one column, small margins. The things a cook or cashier looks for first
 * (pickup time, items, allergies) are biggest and bold. Every value that
 * came from a caller is HTML-escaped.
 *
 * Input is the message built by orderMessage() / callbackMessage() in
 * business-actions.js.
 */

const LANGUAGE_NAMES = { en: 'English', es: 'Spanish', fr: 'French', hi: 'Hindi', te: 'Telugu' };

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const money = n => `$${Number(n || 0).toFixed(2)}`;
export const withTax = (subtotal, ratePercent) => Math.round(Number(subtotal) * (100 + Number(ratePercent))) / 100;
/** Short order number staff and callers use: first 4 characters of the id. */
export const orderRef = id => (id ? String(id).replace(/-/g, '').slice(0, 4).toUpperCase() : '');
const shortId = orderRef;

/** Lines under an item: options, spice, notes, allergy. */
function itemDetails(line) {
    const details = [];
    if (line.size && line.size !== 'regular') details.push({ text: `Size: ${line.size}` });
    for (const m of line.modifiers || []) details.push({ text: `+ ${m.name}${m.price ? ` (${money(m.price)})` : ''}` });
    if (line.spice_level && line.spice_level !== 'regular') details.push({ text: `Spice: ${line.spice_level.replace('_', ' ')}` });
    if (line.special_instructions) details.push({ text: `Note: ${line.special_instructions}` });
    if (line.allergy_notes) details.push({ text: `ALLERGY: ${line.allergy_notes}`, alert: true });
    return details;
}

export function ticketSubject(m) {
    if (m.type === 'order_cancelled') {
        const when = m.pickup_time && m.pickup_time !== 'ASAP' ? ` for ${m.pickup_time}` : '';
        return `CANCELLED order ${shortId(m.order_id)}: ${m.customer_name || 'Customer'}${when}. Do not prepare`;
    }
    if (m.type === 'callback_request') return `CALL BACK: ${m.customer_name || 'Caller'} ${m.customer_phone || ''}`.trim();
    const when = m.pickup_time && m.pickup_time !== 'ASAP' ? `SCHEDULED ${m.pickup_time}` : 'ASAP';
    const type = m.order_type === 'delivery' ? 'Delivery' : 'Pickup';
    const id = shortId(m.order_id);
    return `${type} order${id ? ` ${id}` : ''}: ${m.customer_name || 'Customer'}, ${when}${m.allergy_notes || (m.items_structured || []).some(l => l.allergy_notes) ? ', ALLERGY' : ''}`;
}

// Shared inline styles (inline so every mail client and printer keeps them).
const FONT = 'font-family:Arial,Helvetica,sans-serif;color:#000;';
const CELL = 'padding:3px 4px;vertical-align:top;';
const RULE = 'border-top:1px solid #000;';

function page(title, inner) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>@media print{body{margin:0}@page{margin:10mm}}</style></head>
<body style="margin:0;padding:12px;background:#fff;">
<div style="${FONT}max-width:560px;font-size:13px;line-height:1.35;">
${inner}
</div></body></html>`;
}

function header(left, right) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${FONT}border-collapse:collapse;border-bottom:2px solid #000;margin-bottom:6px;">
<tr><td style="font-size:16px;font-weight:bold;padding-bottom:3px;">${left}</td>
<td style="font-size:13px;text-align:right;padding-bottom:3px;white-space:nowrap;">${right}</td></tr></table>`;
}

function box(label, value, { big = false } = {}) {
    return `<div style="border:2px solid #000;padding:4px 6px;margin:6px 0;font-size:${big ? 16 : 13}px;"><b>${label}</b> ${value}</div>`;
}

function footer(m) {
    return `<div style="${RULE}margin-top:8px;padding-top:3px;font-size:11px;">${m.type === 'callback_request' ? 'Call taken by Paahi' : 'Phone order taken by Paahi'}${m.session_id ? ` · call ${escapeHtml(m.session_id)}` : ''}${m.order_id ? ` · order ${escapeHtml(m.order_id)}` : ''}</div>`;
}

function orderHtml(m) {
    const scheduled = m.pickup_time && m.pickup_time !== 'ASAP';
    const cancelled = m.type === 'order_cancelled';
    const type = m.order_type === 'delivery' ? 'DELIVERY' : 'PICKUP';
    const lines = m.items_structured || [];
    const rows = lines.map(l => {
        const details = itemDetails(l).map(d =>
            `<div style="padding-left:10px;${d.alert ? 'font-weight:bold;' : ''}">${escapeHtml(d.text)}</div>`).join('');
        return `<tr><td style="${CELL}font-weight:bold;width:28px;">${escapeHtml(l.quantity)}</td>
<td style="${CELL}"><b>${escapeHtml(l.name)}</b>${details}</td>
<td style="${CELL}text-align:right;white-space:nowrap;">${money(l.line_total)}</td></tr>`;
    }).join('\n');

    const extras = [
        m.allergy_notes ? box('ALLERGY:', escapeHtml(m.allergy_notes), { big: true }) : '',
        m.order_notes ? `<div style="margin:4px 0;"><b>Order note:</b> ${escapeHtml(m.order_notes)}</div>` : '',
        m.delivery_address ? `<div style="margin:4px 0;"><b>Deliver to:</b> ${escapeHtml(m.delivery_address)}</div>` : '',
        m.language && m.language !== 'en' ? `<div style="margin:4px 0;"><b>Caller spoke:</b> ${escapeHtml(LANGUAGE_NAMES[m.language] || m.language)}</div>` : '',
    ].join('');

    return page(ticketSubject(m), [
        header(`${escapeHtml(m.business_name || '')} · ${cancelled ? 'CANCELLED' : `${type} ORDER`}`, `#${escapeHtml(shortId(m.order_id))}`),
        cancelled ? box('CANCELLED BY CALLER.', 'Do not prepare this order.', { big: true }) : '',
        box(`${type}:`, scheduled ? `SCHEDULED ${escapeHtml(m.pickup_time)}` : 'As soon as possible', { big: true }),
        `<table role="presentation" cellpadding="0" cellspacing="0" style="${FONT}border-collapse:collapse;margin:4px 0;font-size:13px;">
<tr><td style="padding:1px 8px 1px 0;"><b>Customer</b></td><td>${escapeHtml(m.customer_name || 'Not given')}</td></tr>
<tr><td style="padding:1px 8px 1px 0;"><b>Phone</b></td><td>${escapeHtml(m.customer_phone || 'Not given')}</td></tr>
<tr><td style="padding:1px 8px 1px 0;"><b>Placed</b></td><td>${escapeHtml(m.placed_text || '')}</td></tr></table>`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${FONT}border-collapse:collapse;font-size:13px;margin-top:4px;">
<tr style="border-bottom:1px solid #000;"><th style="${CELL}text-align:left;">Qty</th><th style="${CELL}text-align:left;">Item</th><th style="${CELL}text-align:right;">Total</th></tr>
${rows || `<tr><td colspan="3" style="${CELL}">${escapeHtml(m.items || '')}</td></tr>`}
<tr><td colspan="2" style="${CELL}${RULE}text-align:right;"><b>Subtotal</b> (before tax)</td><td style="${CELL}${RULE}text-align:right;"><b>${money(m.subtotal)}</b></td></tr>
${m.tax_rate_percent ? `<tr><td colspan="2" style="${CELL}text-align:right;">Total with ${m.tax_rate_percent}% tax</td><td style="${CELL}text-align:right;">${money(withTax(m.subtotal, m.tax_rate_percent))}</td></tr>` : ''}
</table>`,
        extras,
        footer(m),
    ].join('\n'));
}

function callbackHtml(m) {
    const mentioned = (m.mentioned_items || []).map(escapeHtml).join(', ');
    return page(ticketSubject(m), [
        header(`${escapeHtml(m.business_name || '')} · CALL BACK`, escapeHtml(m.placed_text || '')),
        box('Call:', `${escapeHtml(m.customer_name || 'Caller')} &nbsp; ${escapeHtml(m.customer_phone || 'no number given')}`, { big: true }),
        `<div style="margin:4px 0;"><b>Reason:</b> ${escapeHtml(m.reason || 'Not given')}</div>`,
        mentioned ? `<div style="margin:4px 0;"><b>Not ordered yet, mentioned:</b> ${mentioned}</div>` : '',
        m.language && m.language !== 'en' ? `<div style="margin:4px 0;"><b>Caller spoke:</b> ${escapeHtml(LANGUAGE_NAMES[m.language] || m.language)}</div>` : '',
        `<div style="margin:4px 0;">No order was placed.</div>`,
        footer(m),
    ].join('\n'));
}

export function ticketHtml(m) {
    return m.type === 'callback_request' ? callbackHtml(m) : orderHtml(m);
}

/** Plain-text version (also what a text-only mail client or printer shows). */
export function ticketText(m) {
    const out = [];
    if (m.type === 'callback_request') {
        out.push(`${m.business_name || ''} - CALL BACK`, `Call: ${m.customer_name || 'Caller'}  ${m.customer_phone || 'no number given'}`,
            `Reason: ${m.reason || 'Not given'}`);
        if (m.mentioned_items?.length) out.push(`Not ordered yet, mentioned: ${m.mentioned_items.join(', ')}`);
        if (m.language && m.language !== 'en') out.push(`Caller spoke: ${LANGUAGE_NAMES[m.language] || m.language}`);
        out.push(`Requested: ${m.placed_text || ''}`, 'No order was placed.');
        return out.join('\n');
    }
    const type = m.order_type === 'delivery' ? 'DELIVERY' : 'PICKUP';
    const scheduled = m.pickup_time && m.pickup_time !== 'ASAP';
    if (m.type === 'order_cancelled') out.push('CANCELLED BY CALLER. DO NOT PREPARE.');
    out.push(`${m.business_name || ''} - ${type} ORDER #${shortId(m.order_id)}`,
        `${type}: ${scheduled ? `SCHEDULED ${m.pickup_time}` : 'As soon as possible'}`,
        `Customer: ${m.customer_name || 'Not given'}  ${m.customer_phone || ''}`.trimEnd(),
        `Placed: ${m.placed_text || ''}`, '');
    for (const l of m.items_structured || []) {
        out.push(`${l.quantity} x ${l.name}  ${money(l.line_total)}`);
        for (const d of itemDetails(l)) out.push(`    ${d.text}`);
    }
    out.push(`Subtotal (before tax): ${money(m.subtotal)}`);
    if (m.allergy_notes) out.push(`ALLERGY: ${m.allergy_notes}`);
    if (m.order_notes) out.push(`Order note: ${m.order_notes}`);
    if (m.delivery_address) out.push(`Deliver to: ${m.delivery_address}`);
    if (m.language && m.language !== 'en') out.push(`Caller spoke: ${LANGUAGE_NAMES[m.language] || m.language}`);
    return out.join('\n');
}
