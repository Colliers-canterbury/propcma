// /api/_lib/graph.js
// Microsoft Graph client-credentials helper + accounts notification.
// Reuses the PropCMA app registration; add the application
// permission Mail.Send (admin consent), and restrict it with an
// Exchange application access policy so this app can only send
// as GRAPH_SENDER_UPN:
//   New-ApplicationAccessPolicy -AppId <client-id> `
//     -PolicyScopeGroupId dealsheets@sicommercial.co.nz `
//     -AccessRight RestrictAccess

export async function graphToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );
  if (!res.ok) throw new Error(`Graph token failed: ${res.status}`);
  return (await res.json()).access_token;
}

const nzd = (n) =>
  Number(n || 0).toLocaleString("en-NZ", { style: "currency", currency: "NZD" });

export async function notifyAccounts(deal, ccEmails = []) {
  const link = `${process.env.APP_BASE_URL}/accounts.html?id=${deal.id}`;
  const subject = `Deal sheet submitted — ${deal.property_address}${
    deal.deposit_to_trust ? " [TRUST]" : ""
  }`;

  const isLease = deal.deal_type === "lease";
  // For a lease, the "sale price" figure is actually annual rental. Show
  // Gross when outgoings (opex) are on the deal, otherwise Net.
  const hasOutgoings = isLease && parseFloat(deal.form?.rental?.opex || 0) > 0;
  const rentalLabel = isLease
    ? (hasOutgoings ? "Total Gross Rental p.a. (excl GST)" : "Total Net Rental p.a. (excl GST)")
    : "Sale price (excl GST)";
  const partyLabel = isLease ? "Landlord" : "Vendor";
  const dateLabel = isLease ? "Commencement" : "Unconditional";
  const dateValue = isLease
    ? (deal.form?.lease?.commencementDate || deal.unconditional_date || "—")
    : (deal.unconditional_date || "—");

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1A2233">
      <p>A new deal sheet has been submitted and is ready for processing.</p>
      <table cellpadding="6" style="border-collapse:collapse">
        <tr><td style="color:#66708A">Property</td><td><b>${deal.property_address}</b></td></tr>
        <tr><td style="color:#66708A">Broker</td><td>${deal.salesperson} (${deal.division || "—"})</td></tr>
        <tr><td style="color:#66708A">${partyLabel}</td><td>${deal.vendor_name || "—"}</td></tr>
        <tr><td style="color:#66708A">${dateLabel}</td><td>${dateValue}</td></tr>
        <tr><td style="color:#66708A">${rentalLabel}</td><td>${nzd(deal.sale_price_ex_gst)}</td></tr>
        <tr><td style="color:#66708A">Total to invoice (excl GST)</td><td><b>${nzd(deal.total_invoice_ex_gst)}</b></td></tr>
        <tr><td style="color:#66708A">Trust deposit</td><td>${deal.deposit_to_trust ? "Yes — check receipt" : "No"}</td></tr>
      </table>
      <p><a href="${link}" style="background:#0C9ED9;color:#fff;padding:10px 16px;
        border-radius:6px;text-decoration:none;font-weight:700">Open in Deal Sheet Processing</a></p>
      <p style="color:#66708A;font-size:12px">Assign the File No. and Deal No. in the app —
      replies to this mailbox are not linked to the deal record.</p>
    </div>`;

  const token = await graphToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${process.env.GRAPH_SENDER_UPN}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: [
            { emailAddress: { address: process.env.ACCOUNTS_MAILBOX } },
          ],
          // Brokers on the deal are CC'd so they know it's been filed.
          // Brokers without an email on record are simply skipped.
          ccRecipients: ccEmails.filter(Boolean).map((address) => ({
            emailAddress: { address },
          })),
        },
        saveToSentItems: true,
      }),
    }
  );
  if (!res.ok) {
    // Don't fail the submission over a notification hiccup — log it.
    console.error("Graph sendMail failed", res.status, await res.text());
    return false;
  }
  return true;
}
