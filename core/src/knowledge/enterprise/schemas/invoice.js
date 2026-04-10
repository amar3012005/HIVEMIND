export const invoiceSchema = {
  type: 'invoice',
  label: 'Invoice / Purchase Order',
  description: 'Invoices, purchase orders, billing documents with line items and totals',
  required: ['vendor', 'total_amount', 'currency', 'date'],
  optional: ['invoice_number', 'po_number', 'line_items', 'payment_terms', 'due_date', 'tax_amount', 'billing_address'],
  fields: {
    vendor: { type: 'string', description: 'Vendor or supplier name' },
    total_amount: { type: 'number', description: 'Total invoice amount' },
    currency: { type: 'string', description: 'Currency code (EUR, USD, etc.)' },
    date: { type: 'string', description: 'Invoice date (ISO 8601)' },
    invoice_number: { type: 'string', description: 'Invoice reference number' },
    po_number: { type: 'string', description: 'Purchase order number' },
    line_items: {
      type: 'array',
      description: 'Individual line items',
      items: {
        description: { type: 'string' },
        quantity: { type: 'number' },
        unit_price: { type: 'number' },
        amount: { type: 'number' }
      }
    },
    payment_terms: { type: 'string', description: 'Payment terms (Net 30, etc.)' },
    due_date: { type: 'string', description: 'Payment due date (ISO 8601)' },
    tax_amount: { type: 'number', description: 'Tax amount' },
    billing_address: { type: 'string', description: 'Billing address' }
  },
  chunkBy: 'line_items',
  chunkFallback: 'sections',
  tags: (extracted) => {
    const tags = ['enterprise', 'document_type:invoice'];
    if (extracted.vendor) tags.push(`vendor:${extracted.vendor.toLowerCase().replace(/\s+/g, '-')}`);
    if (extracted.currency) tags.push(`currency:${extracted.currency.toLowerCase()}`);
    return tags;
  }
};
