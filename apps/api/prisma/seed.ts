import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    console.log('Start seeding (idempotent, non-destructive)...');

    // Hashed password reused across demo users
    const basePassword = await bcrypt.hash('password123', 10);

    // ── Demo users: upsert by email so real data is never deleted ──
    const citizen1 = await prisma.user.upsert({
        where: { email: 'fatima@example.com' },
        update: {},
        create: {
            email: 'fatima@example.com',
            phone: '+923001234567',
            password: basePassword,
            role: 'CITIZEN',
        },
    });

    const moderator1 = await prisma.user.upsert({
        where: { email: 'sana.mod@example.com' },
        update: {},
        create: {
            email: 'sana.mod@example.com',
            phone: '+923009876543',
            password: basePassword,
            role: 'MODERATOR',
        },
    });

    const le_analyst = await prisma.user.upsert({
        where: { email: 'khalid.inspector@sindhpolice.gov.pk' },
        update: {},
        create: {
            email: 'khalid.inspector@sindhpolice.gov.pk',
            phone: '+923211234567',
            password: basePassword,
            role: 'LAW_ENFORCEMENT',
        },
    });

    const saif = await prisma.user.upsert({
        where: { email: 'saif@example.com' },
        update: {},
        create: {
            email: 'saif@example.com',
            password: basePassword,
            role: 'CITIZEN',
        },
    });

    const arsalan = await prisma.user.upsert({
        where: { email: 'arsalan@example.com' },
        update: {},
        create: {
            email: 'arsalan@example.com',
            password: basePassword,
            role: 'CITIZEN',
        },
    });

    const maaz = await prisma.user.upsert({
        where: { email: 'maaz@example.com' },
        update: {},
        create: {
            email: 'maaz@example.com',
            password: basePassword,
            role: 'MODERATOR',
        },
    });

    console.log('Ensured demo users exist:', {
        citizen1: citizen1.email,
        moderator1: moderator1.email,
        le: le_analyst.email,
        saif: saif.email,
        arsalan: arsalan.email,
        maaz: maaz.email,
    });

    // ── Demo reports: only seed if there are no existing reports ──
    const reportCount = await prisma.report.count();
    if (reportCount === 0) {
        console.log('No reports found – creating demo hotspot reports...');
        const verifiedAt = new Date();

        const report1 = await prisma.report.create({
            data: {
                title: 'Street Robbery observed',
                description:
                    'Two individuals on a motorcycle intercepted a vehicle. Armed. Suspects fled southbound.',
                type: 'ARMED_ROBBERY',
                latitude: 24.8607,
                longitude: 67.0011,
                severity: 8,
                status: 'VERIFIED',
                verifiedAt,
                authorId: citizen1.id,
                multimedia: {
                    create: [{ url: 'https://example.com/mock-video-1.mp4', type: 'VIDEO' }],
                },
            },
        });

        const report2 = await prisma.report.create({
            data: {
                title: 'Vandalism at public park',
                description: 'Group of teens damaging park benches and lights.',
                type: 'VANDALISM',
                latitude: 24.8715,
                longitude: 67.0305,
                severity: 3,
                status: 'PENDING',
                authorId: citizen1.id,
            },
        });

        const report3 = await prisma.report.create({
            data: {
                title: 'Vehicle break-in',
                description: 'Window smashed on parked Civic, laptop bag stolen.',
                type: 'VEHICLE_CRIME',
                latitude: 24.8522,
                longitude: 67.021,
                severity: 5,
                status: 'VERIFIED',
                verifiedAt,
                authorId: citizen1.id,
            },
        });

        console.log('Created demo reports:', {
            report1: report1.title,
            report2: report2.title,
            report3: report3.title,
        });
    } else {
        console.log(`Reports already exist (${reportCount}) – skipping demo report creation.`);
    }

    console.log('Seeding finished.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
