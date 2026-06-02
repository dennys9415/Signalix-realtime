import { verify } from 'jsonwebtoken';
import { config } from '../config/config';

export interface JwtPayload {
  sub: string;
  deviceId: string;
  type: string;
  iat: number;
  exp: number;
}

export function verifyAccessToken(token: string): JwtPayload {
  const payload = verify(token, config.jwtSecret) as JwtPayload;
  if (payload.type !== 'access') {
    throw new Error('Wrong token type');
  }
  return payload;
}
