import { OpenAICompatibleDocumentAiProvider } from './openai-compatible-document-ai.provider';

describe('OpenAICompatibleDocumentAiProvider', () => {
  const provider = new OpenAICompatibleDocumentAiProvider();
  const previousEnv = {
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
  };
  const fetchMock = jest.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    process.env.AI_BASE_URL = 'https://example.ai/v1/';
    process.env.AI_API_KEY = 'test-secret';
    process.env.AI_MODEL = 'test-model';
    fetchMock.mockReset();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fetchMock.mockRestore();
  });

  function response(content: string): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }

  it('calls the configured OpenAI-compatible endpoint and validates classification output', async () => {
    fetchMock.mockResolvedValue(response('{"documentType":"INVOICE","confidence":0.93}'));

    await expect(provider.classifyDocument('bill.pdf', 'Invoice text')).resolves.toEqual({
      documentType: 'INVOICE',
      confidence: 0.93,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.ai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }),
        body: expect.stringContaining('json_object'),
      }),
    );
  });

  it('limits extraction to configured fields and bounds confidence values', async () => {
    fetchMock.mockResolvedValue(
      response(
        JSON.stringify({
          fields: {
            vendor_name: { value: 'Northwind Ltd', confidence: 0.9 },
            invoice_number: { value: 'INV-99', confidence: 4 },
            arbitrary_secret: { value: 'ignore me', confidence: 1 },
          },
        }),
      ),
    );

    const fields = await provider.extractFields('INVOICE', 'Invoice text', 'invoice.pdf');

    expect(fields.vendor_name).toEqual({
      value: 'Northwind Ltd',
      confidence: 0.9,
      source: 'openai-compatible:test-model',
    });
    expect(fields.invoice_number).toEqual({
      value: 'INV-99',
      confidence: 0,
      source: 'openai-compatible:test-model',
    });
    expect(fields.total).toEqual({ value: null, confidence: 0, source: 'not_found' });
    expect(fields).not.toHaveProperty('arbitrary_secret');
  });

  it('rejects unsuccessful provider responses without exposing response bodies', async () => {
    fetchMock.mockResolvedValue(new Response('sensitive upstream details', { status: 401 }));

    await expect(provider.classifyDocument('bill.pdf', 'Invoice text')).rejects.toThrow('HTTP 401');
  });
});
