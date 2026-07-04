import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { writeAudit } from '../../lib/audit.js';
import { isValidKraPin } from '../../lib/kra-tax.js';

const EmployeeInput = z.object({
  employeeNo: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  position: z.string().min(1),
  department: z.string().optional(),
  branchId: z.string().optional(),
  salary: z.number().nonnegative().default(0),
  allowances: z.number().nonnegative().default(0),
  nationalId: z.string().optional(),
  kraPin: z.string().optional(),
  nhif: z.string().optional(),
  nssf: z.string().optional(),
  bankAccount: z.string().optional(),
  mpesaPhone: z.string().optional(),
  joinDate: z.coerce.date().optional(),
});

const LeaveInput = z.object({
  employeeId: z.string(),
  type: z.enum(['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid']),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  days: z.number().int().positive(),
  reason: z.string().optional(),
});

export async function registerHrRoutes(app: FastifyInstance) {
  // ── Employees ─────────────────────────────────────────────────────────
  app.get('/employees', { preHandler: [requireCap('employees.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    return prisma.employee.findMany({
      where: { workspaceId: me.workspaceId, status: 'active' },
      orderBy: { name: 'asc' },
    });
  });

  app.post(
    '/employees',
    { preHandler: [requireCap('employees.create')], schema: { body: EmployeeInput } },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof EmployeeInput>;
      if (b.kraPin && !isValidKraPin(b.kraPin)) {
        return reply.code(400).send({ message: 'Invalid KRA PIN', code: 'BAD_KRA_PIN' });
      }
      const emp = await prisma.employee.create({
        data: { workspaceId: me.workspaceId, ...b },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'employee.create',
        resource: 'employee',
        resourceId: emp.id,
        ip: req.ip,
      });
      return emp;
    },
  );

  app.put(
    '/employees/:id',
    {
      preHandler: [requireCap('employees.update')],
      schema: { body: EmployeeInput.partial() },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const b = req.body as Partial<z.infer<typeof EmployeeInput>>;
      if (b.kraPin && !isValidKraPin(b.kraPin)) {
        return reply.code(400).send({ message: 'Invalid KRA PIN', code: 'BAD_KRA_PIN' });
      }
      const { count } = await prisma.employee.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: b,
      });
      if (count === 0) return reply.code(404).send({ message: 'Employee not found' });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'employee.update',
        resource: 'employee',
        resourceId: id,
        ip: req.ip,
      });
      return prisma.employee.findUnique({ where: { id } });
    },
  );

  app.post(
    '/employees/:id/terminate',
    { preHandler: [requireCap('employees.terminate')] },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const { count } = await prisma.employee.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: { status: 'terminated' },
      });
      if (count === 0) return reply.code(404).send({ message: 'Employee not found' });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'employee.terminate',
        resource: 'employee',
        resourceId: id,
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  // ── Leave requests ───────────────────────────────────────────────────
  app.get('/leave', { preHandler: [requireCap('hr.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const q = req.query as { status?: string };
    return prisma.leaveRequest.findMany({
      where: {
        employee: { workspaceId: me.workspaceId },
        ...(q.status ? { status: q.status } : {}),
      },
      include: { employee: { select: { id: true, name: true, position: true } } },
      orderBy: { requestedAt: 'desc' },
      take: 500,
    });
  });

  app.post(
    '/leave',
    { preHandler: [requireCap('hr.write')], schema: { body: LeaveInput } },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof LeaveInput>;
      // Verify employee belongs to workspace.
      const emp = await prisma.employee.findFirst({
        where: { id: b.employeeId, workspaceId: me.workspaceId },
      });
      if (!emp) return reply.code(404).send({ message: 'Employee not found' });
      const lr = await prisma.leaveRequest.create({ data: b });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'leave.request',
        resource: 'leaveRequest',
        resourceId: lr.id,
        meta: { employeeId: b.employeeId, type: b.type, days: b.days },
        ip: req.ip,
      });
      return lr;
    },
  );

  app.post(
    '/leave/:id/approve',
    { preHandler: [requireCap('hr.leave.approve')] },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      // Ensure leave request is within workspace via employee join.
      const lr = await prisma.leaveRequest.findFirst({
        where: { id, employee: { workspaceId: me.workspaceId } },
      });
      if (!lr) return reply.code(404).send({ message: 'Leave request not found' });
      await prisma.leaveRequest.update({
        where: { id },
        data: { status: 'approved', approvedBy: me.id },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'leave.approve',
        resource: 'leaveRequest',
        resourceId: id,
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  app.post(
    '/leave/:id/reject',
    { preHandler: [requireCap('hr.leave.approve')] },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const lr = await prisma.leaveRequest.findFirst({
        where: { id, employee: { workspaceId: me.workspaceId } },
      });
      if (!lr) return reply.code(404).send({ message: 'Leave request not found' });
      await prisma.leaveRequest.update({
        where: { id },
        data: { status: 'rejected', approvedBy: me.id },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'leave.reject',
        resource: 'leaveRequest',
        resourceId: id,
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  // ── Attendance ───────────────────────────────────────────────────────
  app.post(
    '/attendance/checkin',
    {
      preHandler: [requireCap('hr.attendance')],
      schema: { body: z.object({ employeeId: z.string() }) },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const { employeeId } = req.body as { employeeId: string };
      const emp = await prisma.employee.findFirst({
        where: { id: employeeId, workspaceId: me.workspaceId },
      });
      if (!emp) return reply.code(404).send({ message: 'Employee not found' });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const row = await prisma.attendance.upsert({
        where: { employeeId_date: { employeeId, date: today } },
        create: { employeeId, date: today, checkIn: new Date(), status: 'present' },
        update: { checkIn: new Date(), status: 'present' },
      });
      return row;
    },
  );

  app.post(
    '/attendance/checkout',
    {
      preHandler: [requireCap('hr.attendance')],
      schema: { body: z.object({ employeeId: z.string() }) },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const { employeeId } = req.body as { employeeId: string };
      const emp = await prisma.employee.findFirst({
        where: { id: employeeId, workspaceId: me.workspaceId },
      });
      if (!emp) return reply.code(404).send({ message: 'Employee not found' });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const existing = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
      });
      if (!existing) return reply.code(400).send({ message: 'No check-in for today' });
      return prisma.attendance.update({
        where: { employeeId_date: { employeeId, date: today } },
        data: { checkOut: new Date() },
      });
    },
  );
}
