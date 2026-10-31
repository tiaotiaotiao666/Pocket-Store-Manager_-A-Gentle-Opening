import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppError, ErrorMessages } from './app-error';

function collectFields(errors: ValidationError[], parent = ''): string[] {
  const fields: string[] = [];
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints && Object.keys(error.constraints).length > 0) {
      fields.push(path);
    }
    if (error.children && error.children.length > 0) {
      fields.push(...collectFields(error.children, path));
    }
  }
  return fields;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    validateCustomDecorators: true,
    exceptionFactory: (errors: ValidationError[]): AppError => {
      const fields = collectFields(errors);
      const first = errors.find((error) => error.constraints);
      const message = first
        ? Object.values(first.constraints ?? {})[0]
        : ErrorMessages.VALIDATION_ERROR;
      return new AppError(422, 'VALIDATION_ERROR', message || ErrorMessages.VALIDATION_ERROR, {
        fields,
      });
    },
  });
}