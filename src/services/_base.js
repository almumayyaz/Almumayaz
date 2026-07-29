class AppError extends Error {
  constructor(message, code = 'INTERNAL_ERROR', status = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 'NOT_FOUND', 404);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 'CONFLICT', 409);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN', 403);
  }
}

class BaseService {
  constructor(repository) {
    if (!repository) throw new Error('BaseService requires a repository');
    this.repo = repository;
  }

  async get(id) {
    const doc = await this.repo.get(id);
    if (!doc) throw new NotFoundError(`${this.repo.collectionName}:${id} not found`);
    if (doc.deleted) throw new NotFoundError(`${this.repo.collectionName}:${id} has been deleted`);
    return doc;
  }

  async create(data, userId) {
    return this.repo.create(data, userId);
  }

  async update(id, data, userId) {
    await this.get(id);
    return this.repo.update(id, data, userId);
  }

  async delete(id, userId) {
    await this.get(id);
    return this.repo.softDelete(id, userId);
  }

  async list(filters = {}, options = {}) {
    return this.repo.query(filters, options);
  }

  async paginate(filters = {}, options = {}) {
    return this.repo.paginate(filters, options);
  }
}

module.exports = {
  BaseService,
  AppError,
  NotFoundError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError
};
