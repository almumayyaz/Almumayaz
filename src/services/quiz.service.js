const repos = require('../repositories');
const { BaseService, NotFoundError, ValidationError } = require('./_base');

class QuizService extends BaseService {
  constructor() {
    super(repos.QuizRepository);
    this.questionRepo = repos.QuestionRepository;
    this.examAttemptRepo = repos.ExamAttemptRepository;
  }

  async getWithQuestions(quizId) {
    const quiz = await this.get(quizId);
    const questions = await this.questionRepo.findByQuiz(quizId);
    return { ...quiz, questions };
  }

  async gradeAttempt(quizId, userId, answers) {
    const quiz = await this.getWithQuestions(quizId);
    let score = 0;

    for (const answer of answers) {
      const question = quiz.questions.find(q => q.id === answer.questionId);
      if (question && question.correct === answer.selected) {
        score++;
      }
    }

    const total = quiz.questions.length;
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
    const passed = percentage >= (quiz.passPercentage || 60);

    const attempt = await this.examAttemptRepo.create({
      userId,
      quizId,
      score,
      total,
      percentage,
      passed,
      answers,
      attemptedAt: Date.now(),
      attemptNumber: (await this.examAttemptRepo.getAttemptCount(userId, quizId)) + 1,
    }, userId);

    return { score, total, percentage, passed, attemptId: attempt.id };
  }

  async getByEntity(entityType, entityId) {
    return this.repo.findByEntity(entityType, entityId);
  }

  async getCourseQuiz(courseId) {
    return this.repo.findCourseQuiz(courseId);
  }

  async getLessonQuiz(lessonId) {
    return this.repo.findLessonQuiz(lessonId);
  }

  async getUserAttempts(userId, quizId) {
    return this.examAttemptRepo.findByUserAndQuiz(userId, quizId);
  }

  async getBestAttempt(userId, quizId) {
    const attempts = await this.getUserAttempts(userId, quizId);
    return attempts.reduce((best, a) => !best || a.percentage > best.percentage ? a : best, null);
  }
}

module.exports = new QuizService();
