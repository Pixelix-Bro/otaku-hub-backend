export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: string, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class TelegramApiError extends AppError {
  public readonly telegramErrorCode: number | undefined;
  public readonly telegramDescription: string | undefined;

  constructor(
    message: string,
    telegramErrorCode?: number,
    telegramDescription?: string,
  ) {
    super(message, 502, 'TELEGRAM_API_ERROR');
    this.telegramErrorCode = telegramErrorCode;
    this.telegramDescription = telegramDescription;
  }
}

export class StorageError extends AppError {
  constructor(message = 'Storage operation failed') {
    super(message, 500, 'STORAGE_ERROR');
  }
}

export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed') {
    super(message, 500, 'DATABASE_ERROR', false);
  }
}
