const { DataService } = require('../src/data/data.service');

describe('DataService raw-query behavior', () => {
  it('stores and returns registration intents through the database adapter', async () => {
    const record = { id: 'registration-1', email: 'test@example.com' };
    const prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      $queryRawUnsafe: jest.fn().mockResolvedValue([record]),
    };
    const service = new DataService(prisma, undefined);

    const created = await service.insert('registration_intents', {
      full_name: 'Test User',
      email: 'test@example.com',
      phone: '123',
      affiliation: 'Org',
      country: 'India',
      designation: 'Speaker',
      plan_key: 'early-speaker',
      plan_name: 'Early Speaker',
      amount_usd: 100,
      currency: 'USD',
      payment_provider: 'stripe',
      payment_status: 'pending',
      status: 'pending',
      notes: 'test',
    });

    expect(created).toEqual(record);

    const rows = await service.list('registration_intents', { email: 'test@example.com' });
    expect(rows).toEqual([record]);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('DataService PayPal checkout', () => {
  it('accepts payer-action approval links', async () => {
    const service = new DataService({}, undefined);
    jest.spyOn(service, 'payPalRequest').mockResolvedValue({
      id: 'paypal-order-1',
      links: [{ rel: 'payer-action', href: 'https://paypal.example/approve' }],
    });

    await expect(service.createPayPalCheckout('registration-1', {}, 149, 'https://conference.example'))
      .resolves.toEqual({
        url: 'https://paypal.example/approve',
        reference: 'paypal-order-1',
      });
  });

  it('uses production PayPal credentials with a whitespace-padded production mode and requests a full order response', async () => {
    const service = new DataService({}, undefined);
    const originalFetch = global.fetch;
    const originalMode = process.env.PAYMENT_MODE;
    const originalClientId = process.env.PAYPAL_CLIENT_ID;
    const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
    process.env.PAYMENT_MODE = ' Production ';
    process.env.PAYPAL_CLIENT_ID = 'unit-test-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'unit-test-client-secret';
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'test-access-token' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'paypal-order-1' }) });

    try {
      await service.payPalRequest('/v2/checkout/orders', 'POST', {});
      expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
        'https://api-m.paypal.com/v1/oauth2/token',
        'https://api-m.paypal.com/v2/checkout/orders',
      ]);
      expect(global.fetch.mock.calls[1][1].headers.Prefer).toBe('return=representation');
    } finally {
      global.fetch = originalFetch;
      if (originalMode === undefined) delete process.env.PAYMENT_MODE;
      else process.env.PAYMENT_MODE = originalMode;
      if (originalClientId === undefined) delete process.env.PAYPAL_CLIENT_ID;
      else process.env.PAYPAL_CLIENT_ID = originalClientId;
      if (originalClientSecret === undefined) delete process.env.PAYPAL_CLIENT_SECRET;
      else process.env.PAYPAL_CLIENT_SECRET = originalClientSecret;
    }
  });
});
