import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
    },
  } as any;

  const mockJwtService = {
    signAsync: jest.fn(),
  } as any;

  const service = new AuthService(mockPrisma, mockJwtService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a 401 when the stored hash is not a valid bcrypt hash', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      passwordHash: 'development-only-hash',
    });

    await expect(
      service.login({ email: 'admin@example.com', password: 'demo-password' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('signs a JWT when the credentials are valid', async () => {
    const passwordHash = await bcrypt.hash('demo-password', 12);

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      passwordHash,
    });

    mockJwtService.signAsync.mockResolvedValue('signed-jwt');

    await expect(
      service.login({ email: 'admin@example.com', password: 'demo-password' }),
    ).resolves.toEqual({ accessToken: 'signed-jwt' });
  });
});
