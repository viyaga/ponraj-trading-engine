import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from 'dotenv'

config()

/**
 * Middleware for the bot‑engine service that ensures a request originates from the
 * trusted backend (or any other service that holds the ENGINE_JWT_SECRET).
 * It expects an `Authorization: Bearer <jwt>` header where the JWT payload
 * contains a `roles` array with the value "engine".
 */
export default function engineAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' })
  }

  const token = authHeader.split(' ')[1]
  try {
    const payload = jwt.verify(token, process.env.ENGINE_JWT_SECRET as string) as any
    if (!payload?.roles?.includes('engine')) {
      return res.status(403).json({ error: 'Insufficient role' })
    }
(req as any).user = { id: payload.sub, email: payload.email, roles: payload.roles }
    next()
  } catch (err) {
    console.error('Engine JWT verification failed', err)
    return res.status(401).json({ error: 'Invalid token' })
  }
}
