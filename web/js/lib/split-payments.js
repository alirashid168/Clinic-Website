// Money taken in one go as more than one payment (owner, 17 Oct 2026: "some times patient pays half in cash and half by card or
// smthng, there should be a add payment too so multiple payment forms could be entered"). The invoice form's "Payment now" and the
// Take payment dialog have a row per payment (its method and its amount) and "+ Add payment"; each row that has an amount is saved
// as a payment of its own (views/staff/invoice.js). What the rows say is read here, a pure function tested in Node
// (tests/split-payments.test.ts).

/**
 * rows: [{ method, amount }] as the form has them (the amount as typed). A row left empty or with 0 is not a payment; two rows with
 * the same method are two payments (unusual, but allowed). Gives { errors: [{ index, message }], payments: [{ index, method, amount }],
 * paid }: index is the row's place in rows, paid what the payments add up to (only the rows read without an error).
 */
export function readPayments(rows) {
  const errors = [];
  const payments = [];
  (rows || []).forEach((row, index) => {
    const text = String(row?.amount ?? '').trim();
    if (text === '') return;
    const amount = Number(text);
    if (!Number.isFinite(amount)) errors.push({ index, message: 'Write the amount in rupees.' });
    else if (amount < 0) errors.push({ index, message: 'The payment cannot be negative. Write 0 when nothing is paid now.' });
    else if (amount > 0) payments.push({ index, method: row.method, amount });
  });
  return { errors, payments, paid: payments.reduce((s, p) => s + p.amount, 0) };
}

/** The method a new row starts with: the first of methods ([{ value }]) no row has yet, else the first. */
export function nextMethod(methods, used) {
  const taken = new Set(used || []);
  return (methods.find((m) => !taken.has(m.value)) || methods[0])?.value;
}
