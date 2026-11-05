export class InvalidReviewReportError extends Error {
  override readonly name = 'InvalidReviewReportError'
  readonly preview: string

  constructor(reason: string, preview: string) {
    super(`The AI did not return a valid review (${reason}).`)
    this.preview = preview
  }
}

export class InvalidLessonsAnswerError extends Error {
  override readonly name = 'InvalidLessonsAnswerError'
  readonly preview: string

  constructor(reason: string, preview: string) {
    super(`The AI did not return valid lessons (${reason}).`)
    this.preview = preview
  }
}
