import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { CloudinaryService } from '../storage/cloudinary.service';

type Sort = { column: string; ascending?: boolean };

type TableConfig = {
  columns: string[];
  writable: string[];
  defaultOrder?: Sort[];
};

const TABLES: Record<string, TableConfig> = {
  site_data: {
    columns: ['id', 'data_key', 'label', 'value', 'value_type', 'group_name', 'is_public', 'created_at', 'updated_at'],
    writable: ['data_key', 'label', 'value', 'value_type', 'group_name', 'is_public'],
    defaultOrder: [{ column: 'group_name' }, { column: 'label' }],
  },
  website_content: {
    columns: ['id', 'section_key', 'title', 'content', 'metadata', 'updated_at', 'updated_by'],
    writable: ['section_key', 'title', 'content', 'metadata', 'updated_by'],
    defaultOrder: [{ column: 'section_key' }],
  },
  speakers: {
    columns: ['id', 'name', 'title', 'organization', 'topic', 'bio', 'image_url', 'session_type', 'display_order', 'is_visible', 'created_at', 'updated_at'],
    writable: ['name', 'title', 'organization', 'topic', 'bio', 'image_url', 'session_type', 'display_order', 'is_visible'],
    defaultOrder: [{ column: 'display_order' }, { column: 'created_at' }],
  },
  media_partners: {
    columns: ['id', 'name', 'description', 'logo_url', 'website_url', 'tier', 'display_order', 'is_visible', 'created_at', 'updated_at'],
    writable: ['name', 'description', 'logo_url', 'website_url', 'tier', 'display_order', 'is_visible'],
    defaultOrder: [{ column: 'display_order' }, { column: 'created_at' }],
  },
  information_blocks: {
    columns: ['id', 'title', 'subtitle', 'content', 'category', 'cta_label', 'cta_url', 'display_order', 'is_visible', 'created_at', 'updated_at'],
    writable: ['title', 'subtitle', 'content', 'category', 'cta_label', 'cta_url', 'display_order', 'is_visible'],
    defaultOrder: [{ column: 'display_order' }, { column: 'created_at' }],
  },
  contact_messages: {
    columns: ['id', 'name', 'email', 'subject', 'message', 'status', 'created_at'],
    writable: ['name', 'email', 'subject', 'message', 'status'],
    defaultOrder: [{ column: 'created_at', ascending: false }],
  },
  abstract_submissions: {
    columns: ['id', 'full_name', 'email', 'phone', 'affiliation', 'country', 'session', 'abstract_title', 'abstract_text', 'presentation_type', 'keywords', 'supporting_text', 'drive_url', 'website_url', 'file_paths', 'voice_file_name', 'voice_file_path', 'status', 'created_at'],
    writable: ['full_name', 'email', 'phone', 'affiliation', 'country', 'session', 'abstract_title', 'abstract_text', 'presentation_type', 'keywords', 'supporting_text', 'drive_url', 'website_url', 'file_paths', 'voice_file_name', 'voice_file_path', 'status'],
    defaultOrder: [{ column: 'created_at', ascending: false }],
  },
  registration_intents: {
    columns: ['id', 'full_name', 'email', 'phone', 'country', 'affiliation', 'designation', 'plan_key', 'plan_name', 'amount_usd', 'currency', 'payment_provider', 'payment_status', 'payment_reference', 'payment_session_id', 'payment_order_id', 'gateway_response', 'status', 'notes', 'redirect_url', 'redirected_at', 'completed_at', 'cancelled_at', 'created_at', 'updated_at', 'coupon_code'],
    writable: ['full_name', 'email', 'phone', 'country', 'affiliation', 'designation', 'plan_key', 'plan_name', 'amount_usd', 'currency', 'payment_provider', 'payment_status', 'payment_reference', 'payment_session_id', 'payment_order_id', 'gateway_response', 'status', 'notes', 'redirect_url', 'redirected_at', 'completed_at', 'cancelled_at', 'coupon_code'],
    defaultOrder: [{ column: 'created_at', ascending: false }],
  },
  coupon_codes: {
    columns: ['id', 'code', 'description', 'discount_percent', 'discount_amount', 'max_uses', 'current_uses', 'is_active', 'valid_from', 'valid_until', 'created_at'],
    writable: ['code', 'description', 'discount_percent', 'discount_amount', 'max_uses', 'current_uses', 'is_active', 'valid_from', 'valid_until'],
    defaultOrder: [{ column: 'created_at', ascending: false }],
  },
};

const DEFAULT_PRICES: Record<string, Record<string, number>> = {
  speaker: { pre: 109, early: 149, mid: 179, onspot: 199 },
  poster: { pre: 69, early: 99, mid: 129, onspot: 149 },
  student: { pre: 49, early: 59, mid: 79, onspot: 99 },
  delegate: { pre: 39, early: 49, mid: 69, onspot: 89 },
};

@Injectable()
export class DataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async list(table: string, filters: Record<string, unknown> = {}, order: Sort[] = []) {
    const config = this.getTable(table);
    const where = this.buildWhere(config, filters);
    const sorts = order.length ? order : config.defaultOrder ?? [];
    const sql = [
      `SELECT ${config.columns.map((column) => `\`${column}\``).join(', ')} FROM \`${table}\``,
      where.sql,
      this.buildOrder(config, sorts),
    ].filter(Boolean).join(' ');

    return (this.prisma as any).$queryRawUnsafe(sql, ...where.values);
  }

  async insert(table: string, payload: Record<string, unknown> | Record<string, unknown>[]) {
    const rows = Array.isArray(payload) ? payload : [payload];
    const created = [];

    for (const row of rows) {
      const data = this.pickWritable(table, row, true);
      if (!data.id) data.id = randomUUID();
      const columns = Object.keys(data);
      if (!columns.length) throw new BadRequestException('No writable fields provided');

      const placeholders = columns.map(() => '?').join(', ');
      const sql = `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(', ')}) VALUES (${placeholders})`;
      await (this.prisma as any).$executeRawUnsafe(sql, ...columns.map((column) => this.normalizeValue(data[column])));
      const [inserted] = await this.list(table, { id: data.id }) as any[];
      created.push(inserted);
    }

    return Array.isArray(payload) ? created : created[0];
  }

  async createPublicRegistration(payload: Record<string, unknown>) {
    const fullName = String(payload.full_name || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const planKey = String(payload.plan_key || '').trim().toLowerCase();
    const provider = String(payload.payment_provider || 'stripe').toLowerCase();
    if (!fullName || !email || !/^\S+@\S+\.\S+$/.test(email)) throw new BadRequestException('A valid name and email are required');
    if (!['stripe', 'paypal'].includes(provider)) throw new BadRequestException('Unsupported payment provider');

    const plan = await this.resolveRegistrationPlan(planKey);
    let amount = plan.amount;
    let couponCode: string | null = null;
    const requestedCoupon = String(payload.coupon_code || '').trim();
    if (requestedCoupon) {
      const coupon = await this.validateCoupon(requestedCoupon, amount);
      if (!coupon.valid) throw new BadRequestException(coupon.message || 'Invalid coupon');
      amount = Number(coupon.final_amount);
      couponCode = String(coupon.code);
    }

    const total = Math.round(amount * 1.05 * 100) / 100;
    return this.insert('registration_intents', {
      full_name: fullName,
      email,
      phone: String(payload.phone || '').trim() || 'Not provided',
      affiliation: String(payload.affiliation || '').trim(),
      country: String(payload.country || '').trim(),
      designation: String(payload.designation || plan.label).trim(),
      plan_key: planKey,
      plan_name: plan.label,
      amount_usd: total,
      currency: 'USD',
      coupon_code: couponCode,
      payment_provider: provider,
      payment_status: 'pending',
      status: 'initiated',
      notes: String(payload.notes || '').slice(0, 4000),
    });
  }

  async createPublicContactMessage(payload: Record<string, unknown>) {
    const name = String(payload.name || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const message = String(payload.message || '').trim();
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !message) throw new BadRequestException('Name, email, and message are required');
    return this.insert('contact_messages', { name, email, subject: String(payload.subject || '').trim().slice(0, 255), message: message.slice(0, 10000), status: 'new' });
  }

  async createPublicAbstractSubmission(payload: Record<string, unknown>) {
    const fullName = String(payload.full_name || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const title = String(payload.abstract_title || '').trim();
    if (!fullName || !/^\S+@\S+\.\S+$/.test(email) || !title) throw new BadRequestException('Name, email, and abstract title are required');
    const allowed = TABLES.abstract_submissions.writable;
    const cleaned = Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.includes(key)));
    return this.insert('abstract_submissions', { ...cleaned, full_name: fullName, email, abstract_title: title, status: 'pending' });
  }

  async upsert(table: string, payload: Record<string, unknown> | Record<string, unknown>[], onConflict?: string) {
    const config = this.getTable(table);
    const conflictColumn = onConflict || 'id';
    if (!config.columns.includes(conflictColumn)) throw new BadRequestException(`Unknown conflict column: ${conflictColumn}`);

    const rows = Array.isArray(payload) ? payload : [payload];
    const saved = [];

    for (const row of rows) {
      const data = this.pickWritable(table, row, true);
      if (!data.id) data.id = randomUUID();
      const columns = Object.keys(data);
      if (!columns.length) throw new BadRequestException('No writable fields provided');
      if (data[conflictColumn] === undefined) throw new BadRequestException(`Conflict column is required: ${conflictColumn}`);

      const updateColumns = columns.filter((column) => column !== 'id' && column !== conflictColumn);
      const placeholders = columns.map(() => '?').join(', ');
      const updateClause = updateColumns.length
        ? updateColumns.map((column) => `\`${column}\` = VALUES(\`${column}\`)`).join(', ')
        : `\`${conflictColumn}\` = VALUES(\`${conflictColumn}\`)`;
      const sql = [
        `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(', ')}) VALUES (${placeholders})`,
        `ON DUPLICATE KEY UPDATE ${updateClause}`,
      ].join(' ');

      await (this.prisma as any).$executeRawUnsafe(sql, ...columns.map((column) => this.normalizeValue(data[column])));
      const [latest] = await this.list(table, { [conflictColumn]: data[conflictColumn] }) as any[];
      saved.push(latest);
    }

    return Array.isArray(payload) ? saved : saved[0];
  }

  async update(table: string, id: string, payload: Record<string, unknown>) {
    const data = this.pickWritable(table, payload);
    const columns = Object.keys(data);
    if (!columns.length) throw new BadRequestException('No writable fields provided');

    const setClause = columns.map((column) => `\`${column}\` = ?`).join(', ');
    await (this.prisma as any).$executeRawUnsafe(
      `UPDATE \`${table}\` SET ${setClause} WHERE \`id\` = ?`,
      ...columns.map((column) => this.normalizeValue(data[column])),
      id,
    );
    const rows = await this.list(table, { id });
    return (rows as any[])[0] ?? null;
  }

  async delete(table: string, id: string) {
    this.getTable(table);
    if (table === 'abstract_submissions') {
      const rows = await this.list(table, { id }) as Array<Record<string, unknown>>;
      const submission = rows[0];
      if (submission) {
        let storedFiles: unknown = submission.file_paths;
        if (typeof storedFiles === 'string') {
          try { storedFiles = JSON.parse(storedFiles); } catch { storedFiles = []; }
        }
        const paths = [
          ...(Array.isArray(storedFiles) ? storedFiles.map((file: any) => typeof file === 'string' ? file : file?.path) : []),
          submission.voice_file_path,
        ].filter((path): path is string => typeof path === 'string' && path.length > 0);
        await Promise.all(paths.map((path) => this.cloudinaryService.deleteLocalFile(`abstract-assets/${path.replace(/^abstract-assets\//, '')}`)));
      }
    }
    await (this.prisma as any).$executeRawUnsafe(`DELETE FROM \`${table}\` WHERE \`id\` = ?`, id);
    return { id };
  }

  async createStripeCheckout(payload: Record<string, unknown>) {
    return this.createHostedCheckout('stripe', payload);
  }

  async createPayPalOrder(payload: Record<string, unknown>) {
    return this.createHostedCheckout('paypal', payload);
  }

  async capturePayPalOrder(payload: Record<string, unknown>) {
    const registrationId = String(payload.registrationId ?? payload.p_registration_id ?? payload.registration_id ?? '');
    const orderId = String(payload.orderId ?? payload.p_payment_order_id ?? payload.payment_order_id ?? '');

    if (!registrationId) throw new BadRequestException('Registration id is required');
    if (!orderId) throw new BadRequestException('PayPal order id is required');

    const order = await this.payPalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST', {});
    if (String(order.status).toUpperCase() !== 'COMPLETED') {
      throw new BadRequestException(`PayPal order is not complete (status: ${String(order.status || 'unknown')})`);
    }

    const capture = (order.purchase_units as any[])?.[0]?.payments?.captures?.[0];
    const result = await this.updateRegistrationPayment({
      p_registration_id: registrationId,
      p_payment_status: 'paid',
      p_payment_provider: 'paypal',
      p_payment_order_id: order.id || orderId,
      p_payment_reference: capture?.id || order.id || orderId,
      p_gateway_response: {
        provider: 'paypal',
        orderId,
        capturedAt: new Date().toISOString(),
        source: 'paypal-api-capture',
        order,
      },
    });

    return {
      status: 'paid',
      provider: 'paypal',
      registrationId,
      orderId,
      data: result,
    };
  }

  async validateCoupon(code: string, amountUsd = 0) {
    if (!code) return { valid: false, message: 'Coupon code is required' };
    const rows = await this.list('coupon_codes', { code: code.trim().toUpperCase(), is_active: true }) as any[];
    const coupon = rows[0];
    if (!coupon) return { valid: false, message: 'Invalid coupon code' };

    const now = Date.now();
    if (coupon.valid_from && new Date(coupon.valid_from).getTime() > now) return { valid: false, message: 'Coupon is not active yet' };
    if (coupon.valid_until && new Date(coupon.valid_until).getTime() < now) return { valid: false, message: 'Coupon has expired' };
    if (coupon.max_uses && Number(coupon.current_uses ?? 0) >= Number(coupon.max_uses)) return { valid: false, message: 'Coupon usage limit reached' };

    const percent = Number(coupon.discount_percent ?? 0);
    const amount = Number(coupon.discount_amount ?? 0);
    const discount = amount || Math.round((Number(amountUsd) * percent) / 100);
    return {
      valid: true,
      coupon_id: coupon.id,
      code: coupon.code,
      coupon,
      discount_percent: coupon.discount_percent,
      discount_amount: discount,
      final_amount: Math.max(0, Number(amountUsd) - discount),
    };
  }

  async updateRegistrationPayment(payload: Record<string, unknown>) {
    const id = String(payload.p_registration_id ?? payload.registrationId ?? '');
    if (!id) throw new BadRequestException('Registration id is required');

    const nextPaymentStatus = String(payload.p_payment_status ?? payload.payment_status ?? 'pending');
    const dataToUpdate: Record<string, unknown> = {
      payment_status: nextPaymentStatus,
      payment_provider: payload.p_payment_provider ?? payload.payment_provider,
      payment_reference: payload.p_payment_reference,
      payment_session_id: payload.p_payment_session_id,
      payment_order_id: payload.p_payment_order_id,
      gateway_response: payload.p_gateway_response ?? payload.gateway_response,
      status: payload.p_status ?? payload.status ?? (nextPaymentStatus === 'paid' ? 'confirmed' : 'pending'),
      notes: payload.p_notes ?? payload.notes,
    };

    if (nextPaymentStatus === 'paid') {
      dataToUpdate.completed_at = new Date().toISOString();
    }

    const updated = await this.update('registration_intents', id, dataToUpdate);

    if (nextPaymentStatus === 'paid') {
      await this.sendPaymentSuccessNotification(id, updated as Record<string, unknown>);
    }

    return updated;
  }

  async verifyPaymentWebhook(
    provider: string,
    payload: Record<string, unknown>,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const normalizedProvider = (provider || 'stripe').toLowerCase();
    if (!['stripe', 'paypal'].includes(normalizedProvider)) {
      throw new BadRequestException(`Unsupported payment webhook provider: ${normalizedProvider}`);
    }

    if (!rawBody?.length) throw new BadRequestException('Webhook body is missing');
    if (normalizedProvider === 'stripe') this.verifyStripeSignature(rawBody, this.header(headers, 'stripe-signature'));
    else await this.verifyPayPalWebhook(payload, headers);

    const providerReference = this.getProviderReference(payload, normalizedProvider);

    if (providerReference) {
      const existing = await this.list('registration_intents', { payment_reference: providerReference }) as any[];
      if (existing.length > 0) {
        return {
          received: true,
          duplicate: true,
          provider: normalizedProvider,
          message: 'Duplicate webhook event ignored.',
          registrationId: existing[0].id,
        };
      }
    }

    const registrationId = this.getWebhookRegistrationId(payload, normalizedProvider);
    if (registrationId) {
      const current = (await this.list('registration_intents', { id: registrationId }) as any[])[0];
      if (!current) throw new NotFoundException('Webhook references an unknown registration');

      const isPaid = normalizedProvider === 'stripe'
        ? ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'payment_intent.succeeded'].includes(String(payload.type))
        : String(payload.event_type) === 'PAYMENT.CAPTURE.COMPLETED';

      if (!isPaid) {
        return { received: true, provider: normalizedProvider, ignored: true, message: 'Webhook event does not confirm payment.' };
      }

      await this.updateRegistrationPayment({
        p_registration_id: registrationId,
        p_payment_status: 'paid',
        p_payment_provider: normalizedProvider,
        p_payment_reference: providerReference || `webhook-${normalizedProvider}-${Date.now()}`,
        p_gateway_response: {
          provider: normalizedProvider,
          event: payload,
          verifiedAt: new Date().toISOString(),
        },
      });
    }

    return {
      received: true,
      provider: normalizedProvider,
      message: 'Webhook verified successfully.',
    };
  }

  async getPaymentProviderStatus() {
    return {
      stripe: {
        configured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
        mode: process.env.PAYMENT_MODE || 'sandbox',
      },
      paypal: {
        configured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_WEBHOOK_ID),
        mode: process.env.PAYMENT_MODE || 'sandbox',
      },
      razorpay: {
        configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET),
        mode: process.env.PAYMENT_MODE || 'sandbox',
      },
      phonepe: {
        configured: Boolean(process.env.PHONEPE_MERCHANT_ID && process.env.PHONEPE_SALT_KEY),
        mode: process.env.PAYMENT_MODE || 'sandbox',
      },
    };
  }

  async generateReceipt(payload: Record<string, unknown>) {
    const registrationId = String(payload.registrationId ?? payload.p_registration_id ?? payload.registration_id ?? '');
    if (!registrationId) throw new BadRequestException('Registration id is required');

    const rows = await this.list('registration_intents', { id: registrationId }) as any[];
    const registration = rows[0];
    if (!registration) throw new NotFoundException('Registration not found');

    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => undefined);

    doc.fontSize(22).text('Conference Registration Receipt', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Receipt Number: ${this.generateReceiptNumber(registrationId)}`);
    doc.text(`Acknowledgement Number: ${this.generateAcknowledgementNumber(registrationId)}`);
    doc.text(`Registration ID: ${registration.id}`);
    doc.text(`Attendee: ${registration.full_name || 'N/A'}`);
    doc.text(`Email: ${registration.email || 'N/A'}`);
    doc.text(`Plan: ${registration.plan_name || 'N/A'}`);
    doc.text(`Amount: $${Number(registration.amount_usd ?? registration.amount ?? 0).toFixed(2)}`);
    doc.text(`Payment Provider: ${registration.payment_provider || 'N/A'}`);
    doc.text(`Status: ${registration.payment_status || 'pending'}`);
    doc.text(`Issued At: ${new Date().toLocaleString()}`);
    doc.moveDown();
    doc.text('Thank you for registering. Please keep this receipt for your records.');
    doc.end();

    const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
      const bufferChunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => bufferChunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(bufferChunks)));
      doc.on('error', reject);
    });

    return {
      registrationId,
      receiptNumber: this.generateReceiptNumber(registrationId),
      acknowledgementNumber: this.generateAcknowledgementNumber(registrationId),
      pdfBase64: pdfBuffer.toString('base64'),
      mimeType: 'application/pdf',
      url: `/api/functions/receipt/${registrationId}`,
    };
  }

  async getReceipt(registrationId: string) {
    const rows = await this.list('registration_intents', { id: registrationId }) as any[];
    const registration = rows[0];
    if (!registration) throw new NotFoundException('Registration not found');

    const result = await this.generateReceipt({ registrationId });
    return {
      registrationId,
      receiptNumber: result.receiptNumber,
      acknowledgementNumber: result.acknowledgementNumber,
      pdfBase64: result.pdfBase64,
      mimeType: result.mimeType,
    };
  }

  private async sendPaymentSuccessNotification(registrationId: string, registration: Record<string, unknown> | null) {
    const rows = await this.list('registration_intents', { id: registrationId }) as any[];
    const row = rows[0] || registration;
    if (!row || !row.email) return null;

    const acknowledgementNumber = this.generateAcknowledgementNumber(registrationId);
    const receiptNumber = `RCPT-${new Date().getFullYear()}-${String(registrationId).slice(0, 8).toUpperCase()}`;
    const amount = Number(row.amount_usd ?? row.amount ?? 0).toFixed(2);
    const provider = String(row.payment_provider ?? 'gateway');

    const html = `
      <h1>Registration confirmed</h1>
      <p>Thank you for registering. Your payment has been successfully received.</p>
      <p><strong>Registration ID:</strong> ${row.id ?? registrationId}</p>
      <p><strong>Acknowledgement Number:</strong> ${acknowledgementNumber}</p>
      <p><strong>Receipt Number:</strong> ${receiptNumber}</p>
      <p><strong>Payment Provider:</strong> ${provider}</p>
      <p><strong>Amount:</strong> $${amount}</p>
      <p>You can present this acknowledgement number during check-in.</p>
    `;

    await this.emailService.send({
      to: String(row.email),
      subject: 'Conference Registration Payment Confirmed',
      html,
    });

    return {
      acknowledgementNumber,
      receiptNumber,
      emailSent: true,
    };
  }

  private generateAcknowledgementNumber(registrationId: string) {
    const prefix = 'CONF';
    const suffix = String(registrationId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'PAY';
    return `${prefix}-${suffix}-${new Date().getFullYear()}`;
  }

  private generateReceiptNumber(registrationId: string) {
    const suffix = String(registrationId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'RECEIPT';
    return `RCPT-${suffix}-${new Date().getFullYear()}`;
  }

  private getProviderReference(payload: Record<string, unknown>, provider: string) {
    const data = payload.data as Record<string, unknown> | undefined;
    const event = payload.event as Record<string, unknown> | undefined;

    const candidates = [
      payload.reference,
      payload.payment_reference,
      payload.paymentReference,
      payload.id,
      payload.event_id,
      payload.session_id,
      payload.order_id,
      payload.orderId,
      payload.transaction_id,
      payload.transactionId,
      payload.paymentId,
      payload.payment_id,
      data?.payment_id,
      data?.id,
      event?.id,
    ];

    const value = candidates.find((item) => typeof item === 'string' && item.trim());
    if (!value) return '';

    return `${provider}:${String(value).trim()}`;
  }

  private getWebhookSecret(provider: string) {
    const configMap: Record<string, string> = {
      stripe: process.env.STRIPE_WEBHOOK_SECRET || '',
      razorpay: process.env.RAZORPAY_WEBHOOK_SECRET || '',
      paypal: process.env.PAYPAL_WEBHOOK_SECRET || '',
      phonepe: process.env.PHONEPE_WEBHOOK_SECRET || '',
    };
    return configMap[provider] || '';
  }

  private verifyStripeSignature(rawBody: Buffer, signatureHeader?: string) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('Stripe webhook verification is not configured');
    if (!signatureHeader) throw new UnauthorizedException('Missing Stripe signature');

    const values = signatureHeader.split(',').reduce<Record<string, string[]>>((result, part) => {
      const [key, value] = part.split('=', 2);
      if (key && value) (result[key] ||= []).push(value);
      return result;
    }, {});
    const timestamp = values.t?.[0];
    const signatures = values.v1 || [];
    if (!timestamp || !signatures.length || !/^\d+$/.test(timestamp)) {
      throw new UnauthorizedException('Invalid Stripe signature header');
    }

    // Stripe recommends a five minute tolerance to reject replayed deliveries.
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
      throw new UnauthorizedException('Expired Stripe webhook signature');
    }
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
    const verified = signatures.some((signature) => this.safeCompare(expected, signature));
    if (!verified) throw new UnauthorizedException('Invalid Stripe webhook signature');
  }

  private async verifyPayPalWebhook(payload: Record<string, unknown>, headers: Record<string, string | string[] | undefined>) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) throw new ServiceUnavailableException('PayPal webhook verification is not configured');

    const verification = await this.payPalRequest('/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo: this.header(headers, 'paypal-auth-algo'),
      cert_url: this.header(headers, 'paypal-cert-url'),
      transmission_id: this.header(headers, 'paypal-transmission-id'),
      transmission_sig: this.header(headers, 'paypal-transmission-sig'),
      transmission_time: this.header(headers, 'paypal-transmission-time'),
      webhook_id: webhookId,
      webhook_event: payload,
    });
    if (verification.verification_status !== 'SUCCESS') {
      throw new UnauthorizedException('Invalid PayPal webhook signature');
    }
  }

  private async createStripeCheckoutSession(registrationId: string, registration: Record<string, any>, amount: number, frontendUrl: string) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) throw new ServiceUnavailableException('Stripe is not configured');

    const form = new URLSearchParams({
      mode: 'payment',
      success_url: `${frontendUrl}/registration/success?provider=stripe&registration_id=${encodeURIComponent(registrationId)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/registration/cancel?provider=stripe&registration_id=${encodeURIComponent(registrationId)}`,
      client_reference_id: registrationId,
      'metadata[registration_id]': registrationId,
      'payment_intent_data[metadata][registration_id]': registrationId,
      'line_items[0][price_data][currency]': String(registration.currency || 'USD').toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
      'line_items[0][price_data][product_data][name]': String(registration.plan_name || 'Conference registration'),
      'line_items[0][quantity]': '1',
    });
    if (registration.email) form.set('customer_email', String(registration.email));

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `conference-checkout-${registrationId}`,
      },
      body: form.toString(),
    });
    const result = await response.json().catch(() => ({})) as any;
    if (!response.ok || !result.url) throw new BadRequestException(result?.error?.message || 'Stripe could not create a checkout session');
    return { url: String(result.url), reference: String(result.id) };
  }

  private async createPayPalCheckout(registrationId: string, registration: Record<string, any>, amount: number, frontendUrl: string) {
    const order = await this.payPalRequest('/v2/checkout/orders', 'POST', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: registrationId,
        custom_id: registrationId,
        description: String(registration.plan_name || 'Conference registration'),
        amount: { currency_code: String(registration.currency || 'USD').toUpperCase(), value: amount.toFixed(2) },
      }],
      application_context: {
        return_url: `${frontendUrl}/registration/success?provider=paypal&registration_id=${encodeURIComponent(registrationId)}`,
        cancel_url: `${frontendUrl}/registration/cancel?provider=paypal&registration_id=${encodeURIComponent(registrationId)}`,
        user_action: 'PAY_NOW',
      },
    });
    const approvalUrl = (order.links as any[])?.find(
      (link) => ['approve', 'payer-action'].includes(link.rel) && typeof link.href === 'string' && link.href,
    )?.href;
    if (!approvalUrl) throw new BadRequestException('PayPal did not return an approval URL');
    return { url: String(approvalUrl), reference: String(order.id) };
  }

  private async payPalRequest(path: string, method: 'POST' | 'GET', body?: Record<string, unknown>) {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new ServiceUnavailableException('PayPal is not configured');
    const baseUrl = String(process.env.PAYMENT_MODE || '').trim().toLowerCase() === 'production'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const token = await tokenResponse.json().catch(() => ({})) as any;
    if (!tokenResponse.ok || !token.access_token) throw new ServiceUnavailableException('Could not authenticate with PayPal');

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new BadRequestException(result?.message || 'PayPal request failed');
    return result as Record<string, any>;
  }

  private getWebhookRegistrationId(payload: Record<string, unknown>, provider: string) {
    const data = payload.data as Record<string, any> | undefined;
    const resource = payload.resource as Record<string, any> | undefined;
    if (provider === 'stripe') {
      return String(data?.object?.client_reference_id || data?.object?.metadata?.registration_id || data?.object?.payment_intent?.metadata?.registration_id || '');
    }
    return String(resource?.custom_id || resource?.purchase_units?.[0]?.custom_id || '');
  }

  private header(headers: Record<string, string | string[] | undefined>, name: string) {
    const value = headers[name] || headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private safeCompare(expected: string, actual: string) {
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  }

  private async createHostedCheckout(provider: 'stripe' | 'paypal', payload: Record<string, unknown>) {
    const registrationId = String(payload.registrationId ?? payload.p_registration_id ?? payload.registration_id ?? '');
    if (!registrationId) throw new BadRequestException('Registration id is required');

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '');
    const registration = await this.list('registration_intents', { id: registrationId }) as any[];
    const registrationRow = registration[0] ?? {};
    const amount = Number(registrationRow.amount_usd ?? payload.amountUsd ?? payload.amount ?? 0);
    const email = String(registrationRow.email ?? payload.email ?? '');
    if (!registrationRow.id) throw new NotFoundException('Registration not found');
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Registration amount must be greater than zero');

    const checkout = provider === 'stripe'
      ? await this.createStripeCheckoutSession(registrationId, registrationRow, amount, frontendUrl)
      : await this.createPayPalCheckout(registrationId, registrationRow, amount, frontendUrl);

    await this.updateRegistrationPayment({
      p_registration_id: registrationId,
      p_payment_provider: provider,
      p_payment_status: 'pending',
      p_payment_reference: checkout.reference,
      ...(provider === 'stripe' ? { p_payment_session_id: checkout.reference } : { p_payment_order_id: checkout.reference }),
      p_gateway_response: {
        provider,
        registrationId,
        url: checkout.url,
        reference: checkout.reference,
        createdAt: new Date().toISOString(),
        mode: 'provider-api',
      },
    });

    return {
      provider,
      registrationId,
      url: checkout.url,
      status: 'pending',
      message: 'Payment session created successfully.',
    };
  }

  private appendPaymentParams(paymentUrl: string, params: Record<string, string | number | null | undefined>) {
    try {
      const url = new URL(paymentUrl);
      Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && String(value).trim()) {
          url.searchParams.set(key, String(value));
        }
      });
      return url.toString();
    } catch {
      return paymentUrl;
    }
  }

  private async resolveRegistrationPlan(planKey: string) {
    const match = /^(pre|early|mid|onspot)-(speaker|poster|student|delegate)$/.exec(planKey);
    if (!match) throw new BadRequestException('Invalid registration plan');
    const [, period, category] = match;
    const priceField: Record<string, string> = { pre: 'preEarly', early: 'earlyBird', mid: 'midterm', onspot: 'onSpot' };
    let amount = DEFAULT_PRICES[category][period];
    let label = category.charAt(0).toUpperCase() + category.slice(1);

    const settings = await this.list('site_data', { data_key: 'registration_pricing' }) as any[];
    if (settings[0]?.value) {
      try {
        const prices = JSON.parse(String(settings[0].value));
        const configured = Array.isArray(prices) ? prices.find((row) => row?.id === category) : undefined;
        if (configured && Number.isFinite(Number(configured[priceField[period]]))) {
          amount = Number(configured[priceField[period]]);
          label = String(configured.category || label);
        }
      } catch {
        // Defaults keep checkout available if a non-critical display setting is malformed.
      }
    }
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('This registration plan is unavailable');
    return { amount, label };
  }

  private getTable(table: string) {
    const config = TABLES[table];
    if (!config) throw new NotFoundException(`Unknown table: ${table}`);
    return config;
  }

  private buildWhere(config: TableConfig, filters: Record<string, unknown>) {
    const clauses: string[] = [];
    const values: unknown[] = [];

    Object.entries(filters).forEach(([column, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (!config.columns.includes(column)) throw new BadRequestException(`Unknown column: ${column}`);
      if (Array.isArray(value)) {
        if (!value.length) return;
        clauses.push(`\`${column}\` IN (${value.map(() => '?').join(', ')})`);
        values.push(...value);
        return;
      }
      clauses.push(`\`${column}\` = ?`);
      values.push(value);
    });

    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
  }

  private buildOrder(config: TableConfig, order: Sort[]) {
    const safe = order.filter((item) => config.columns.includes(item.column));
    if (!safe.length) return '';
    return `ORDER BY ${safe.map((item) => `\`${item.column}\` ${item.ascending === false ? 'DESC' : 'ASC'}`).join(', ')}`;
  }

  private pickWritable(table: string, payload: Record<string, unknown>, includeId = false) {
    const config = this.getTable(table);
    const data: Record<string, unknown> = {};
    if (includeId && payload.id !== undefined) data.id = payload.id;
    config.writable.forEach((column) => {
      if (payload[column] !== undefined) data[column] = payload[column];
    });
    return data;
  }

  private normalizeValue(value: unknown) {
    if (value === undefined) return null;
    if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
      return JSON.stringify(value);
    }
    return value;
  }
}
