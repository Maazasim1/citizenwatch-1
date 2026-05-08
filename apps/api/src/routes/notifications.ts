import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { authenticate } from '../middleware/authSession';

const router = Router();

router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId;
        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        res.json({ notifications });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

router.post('/:id/read', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId;
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        
        const notif = await prisma.notification.findUnique({ where: { id } });
        if (!notif || notif.userId !== userId) {
            return res.status(404).json({ error: 'Not found' });
        }

        const updated = await prisma.notification.update({
            where: { id },
            data: { isRead: true }
        });
        
        res.json({ success: true, notification: updated });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId;
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });

        const notif = await prisma.notification.findUnique({ where: { id } });
        if (!notif || notif.userId !== userId) {
            return res.status(404).json({ error: 'Not found' });
        }

        await prisma.notification.delete({ where: { id } });
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

router.delete('/', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId;
        const result = await prisma.notification.deleteMany({ where: { userId } });
        res.json({ success: true, deletedCount: result.count });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to clear notifications' });
    }
});

export default router;
