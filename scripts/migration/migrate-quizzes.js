const { getClient } = require('./client');
const { createMapping, resolveId, getMappingCount } = require('./id-mapping');
const { readCourses } = require('./legacy-reader');
const { safeDate, safeNumber, safeBoolean, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

async function dryRunQuizzes() {
  const legacy = readCourses();
  let quizCount = 0;
  let questionCount = 0;
  let choiceCount = 0;

  for (const c of legacy) {
    if (!c.lessons || !Array.isArray(c.lessons)) continue;
    for (const l of c.lessons) {
      if (!l.quiz || !l.quiz.enabled) continue;
      quizCount++;
      if (l.quiz.questions && Array.isArray(l.quiz.questions)) {
        for (const q of l.quiz.questions) {
          questionCount++;
          if (q.options && Array.isArray(q.options)) {
            choiceCount += q.options.length;
          }
        }
      }
    }
  }

  console.log('\n══════════════════════════════════');
  console.log('   QUIZZES — DRY RUN');
  console.log('══════════════════════════════════');
  console.log(`  Legacy quizzes:         ${quizCount}`);
  console.log(`  Legacy questions:       ${questionCount}`);
  console.log(`  Legacy choices:         ${choiceCount}`);

  return { quizCount, questionCount, choiceCount };
}

async function migrateQuizzes({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

  if (dryRun) {
    logger.start('Quiz');
    const result = await dryRunQuizzes();
    logger.done('Quiz', 0, result.quizCount);
    logger.start('Question');
    logger.read('Question', result.questionCount);
    logger.done('Question', 0, result.questionCount);
    logger.start('Choice');
    logger.read('Choice', result.choiceCount);
    logger.done('Choice', 0, result.choiceCount);
    return logger.report();
  }

  logger.start('Quiz');
  logger.start('Question');
  logger.start('Choice');

  const legacy = readCourses();
  let quizTotal = 0;
  let questionTotal = 0;
  let choiceTotal = 0;

  for (const c of legacy) {
    if (!c.lessons || !Array.isArray(c.lessons)) continue;
    for (const l of c.lessons) {
      if (!l.quiz || !l.quiz.enabled) continue;
      quizTotal++;
      if (l.quiz.questions && Array.isArray(l.quiz.questions)) {
        for (const q of l.quiz.questions) {
          questionTotal++;
          if (q.options && Array.isArray(q.options)) {
            choiceTotal += q.options.length;
          }
        }
      }
    }
  }

  logger.read('Quiz', quizTotal);
  logger.read('Question', questionTotal);
  logger.read('Choice', choiceTotal);

  let quizCreated = 0;
  let questionCreated = 0;
  let choiceCreated = 0;
  let quizSkipped = 0;

  for (const c of legacy) {
    if (!c.lessons || !Array.isArray(c.lessons)) continue;

    for (const l of c.lessons) {
      if (!l.quiz || !l.quiz.enabled) continue;
      if (!l.id) {
        logger.logSkipped('Quiz', 'unknown', 'lesson has no id');
        quizSkipped++;
        continue;
      }

      const lessonNewId = await resolveId('Lesson', l.id);
      if (!lessonNewId) {
        logger.logSkipped('Quiz', `lesson:${l.id}`, 'lesson not in IdMapping');
        quizSkipped++;
        continue;
      }

      try {
        const existingQuiz = await prisma.quiz.findFirst({
          where: { entityType: 'lesson', entityId: lessonNewId },
        });
        if (existingQuiz) {
          logger.logSkipped('Quiz', `${l.id}`, 'quiz already exists for this lesson');
          quizSkipped++;
          continue;
        }

        const passPct = l.quiz.passPercentage !== undefined
          ? l.quiz.passPercentage
          : l.quiz.passScore || 60;

        const quizId = newCuid();
        await prisma.quiz.create({
          data: {
            id: quizId,
            entityType: 'lesson',
            entityId: lessonNewId,
            title: l.quiz.title || 'اختبار',
            passPercentage: typeof passPct === 'number' ? passPct : Number(passPct) || 60,
            timerMinutes: l.quiz.timerMinutes ? Number(l.quiz.timerMinutes) : null,
            shuffleQuestions: l.quiz.shuffleQuestions || false,
            maxAttempts: l.quiz.maxAttempts ? Number(l.quiz.maxAttempts) : null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });

        logger.logCreated('Quiz', l.id, quizId);
        quizCreated++;

        if (!l.quiz.questions || !Array.isArray(l.quiz.questions)) continue;

        for (let qi = 0; qi < l.quiz.questions.length; qi++) {
          const rawQ = l.quiz.questions[qi];
          if (!rawQ || !rawQ.question) continue;

          try {
            const questionId = newCuid();
            await prisma.question.create({
              data: {
                id: questionId,
                quizId: quizId,
                type: rawQ.type || 'single_choice',
                text: rawQ.question,
                image: rawQ.image || null,
                explanation: rawQ.explanation || null,
                points: safeNumber(rawQ.points, 1),
                order: qi,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });

            logger.logCreated('Question', `${l.id}:q${qi}`, questionId);
            questionCreated++;

            const options = rawQ.options || rawQ.choices || [];
            if (!Array.isArray(options)) continue;

            for (let oi = 0; oi < options.length; oi++) {
              const optText = typeof options[oi] === 'string'
                ? options[oi]
                : (options[oi].text || options[oi].value || '');

              if (!optText) continue;

              const isCorrect = typeof rawQ.correct === 'number'
                ? oi === rawQ.correct
                : !!(options[oi].isCorrect || options[oi].correct);

              try {
                await prisma.choice.create({
                  data: {
                    questionId: questionId,
                    text: optText,
                    isCorrect: isCorrect,
                    order: options[oi].order !== undefined ? options[oi].order : oi,
                    createdAt: new Date(),
                  },
                });
                choiceCreated++;
              } catch (e) {
                logger.logFailed('Choice', `${l.id}:q${qi}:o${oi}`, e);
              }
            }
          } catch (e) {
            logger.logFailed('Question', `${l.id}:q${qi}`, e);
          }
        }
      } catch (e) {
        logger.logFailed('Quiz', l.id, e);
      }
    }
  }

  logger.found('Quiz', quizTotal);
  logger.found('Question', questionTotal);
  logger.found('Choice', choiceTotal);
  logger.done('Quiz', quizCreated, quizSkipped);
  logger.done('Question', questionCreated, questionTotal - questionCreated);
  logger.done('Choice', choiceCreated, choiceTotal - choiceCreated);

  const dbQuizCount = await prisma.quiz.count();
  const dbQuestionCount = await prisma.question.count();
  const dbChoiceCount = await prisma.choice.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyQuizzes: quizTotal,
    legacyQuestions: questionTotal,
    legacyChoices: choiceTotal,
    dbQuizzes: dbQuizCount,
    dbQuestions: dbQuestionCount,
    dbChoices: dbChoiceCount,
    quizCreated,
    questionCreated,
    choiceCreated,
    quizSkipped,
  };
}

module.exports = { migrateQuizzes, dryRunQuizzes };
