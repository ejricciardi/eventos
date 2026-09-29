export class ErrorApi extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const noEncontrado = (que: string) => new ErrorApi(404, `${que} no encontrado`);
