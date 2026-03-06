import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express'
import { createLogger } from '../utils/logger.js'

const log = createLogger('error-handler')

export interface ApiError extends Error {
  statusCode?: number
  code?: string
}

export const errorHandler: ErrorRequestHandler = (
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err.statusCode ?? 500
  const message = err.message || 'Internal Server Error'

  // Known client errors (4xx) get a single-line warning, server errors (5xx) get an error log plus stack trace
  if (statusCode >= 400 && statusCode < 500) {
    log.warn(`${statusCode} ${err.code ?? 'CLIENT_ERROR'}: ${message}`)
  } else {
    log.error(`${statusCode} ${err.code ?? 'INTERNAL_ERROR'}: ${message}`)
    log.error(err.stack ?? 'No stack trace')
  }

  res.status(statusCode).json({
    error: {
      message,
      code: err.code ?? 'INTERNAL_ERROR'
    }
  })
}

export function createError(message: string, statusCode = 500, code?: string): ApiError {
  const error = new Error(message) as ApiError
  error.statusCode = statusCode
  if (code) {
    error.code = code
  }
  return error
}

export function notFound(resource: string): ApiError {
  return createError(`${resource} not found`, 404, 'NOT_FOUND')
}

export function badRequest(message: string): ApiError {
  return createError(message, 400, 'BAD_REQUEST')
}

export function validationError(message: string): ApiError {
  return createError(message, 422, 'VALIDATION_ERROR')
}
