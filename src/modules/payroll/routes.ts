import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { calcPayroll, isValidKraPin } from '../../lib/kra-tax.js';

const CalcInput = z.object({
  grossPay: z.number().nonnegative(),
  pension: z.number().nonnegative().optional(),
  insuranceRelief: z.number().nonnegative().optional(),
  mortgageInterest: z.number().nonnegative().optional(),
  taxYear: z.union([z.literal(2024), z.literal(2025), z.literal(2026)]).optional(),
});

const RunInput = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), // YYYY-MM
  branchId: z.string().optional(),
});

export async function registerPayrollRoutes(app: FastifyInstance) {
  // Pure calculator — useful for what-if UI on an employee card.
  app.post(
    '/calc',
    { preHandler: [requireCap('payroll.read')], schema: { body: CalcInput } },
    async (req) => {
      return calcPayroll(req.body as z.infer<typeof CalcInput>);
    },
  );

  // List runs for the workspace.
  app.get('/runs', { preHandler: [requireCap('payroll.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    return prisma.payrollRun.findMany({
      where: { workspaceId: me.workspaceId },
      orderBy: { period: 'desc' },
      take: 24,
    });
  });

  // Compute a payroll run for a period (YYYY-MM). Iterates active employees.
  app.post(
    '/runs',
    { preHandler: [requireCap('payroll.run')], schema: { body: RunInput } },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { period, branchId } = req.body as z.infer<typeof RunInput>;

      const existing = await prisma.payrollRun.findFirst({
        where: { workspaceId: me.workspaceId, period },
      });
      if (existing) {
        return reply.code(409).send({ message: 'Payroll run for period already exists' });
      }

      const employees = await prisma.employee.findMany({
        where: {
          workspaceId: me.workspaceId,
          status: 'active',
          ...(branchId ? { branchId } : {}),
        },
      });

      // Optionally validate KRA PINs; log rather than fail so runs can proceed.
      const pinIssues = employees
        .filter((e) => e.kraPin && !isValidKraPin(e.kraPin))
        .map((e) => ({ id: e.id, name: e.name, kraPin: e.kraPin }));
      if (pinIssues.length) req.log.warn({ pinIssues }, 'payroll: invalid KRA PINs');

      let grossTotal = 0;
      let deductionsTotal = 0;
      let netTotal = 0;
      const lines = employees.map((e) => {
        const gross = Number(e.salary) + Number(e.allowances ?? 0);
        const bd = calcPayroll({ grossPay: gross });
        grossTotal += bd.gross;
        deductionsTotal += bd.totalEmployeeDeductions;
        netTotal += bd.netPay;
        return {
          employeeId: e.id,
          name: e.name,
          gross: bd.gross,
          nssf: bd.nssfEmployee,
          shif: bd.shif,
          ahl: bd.ahlEmployee,
          paye: bd.payeNet,
          totalDeductions: bd.totalEmployeeDeductions,
          net: bd.netPay,
        };
      });

      const run = await prisma.payrollRun.create({
        data: {
          workspaceId: me.workspaceId,
          period,
          employees: employees.length,
          grossPay: grossTotal,
          deductions: deductionsTotal,
          netPay: netTotal,
          status: 'draft',
          processedBy: me.id,
          processedAt: new Date(),
        },
      });
      return { run, lines, pinIssues };
    },
  );
}
