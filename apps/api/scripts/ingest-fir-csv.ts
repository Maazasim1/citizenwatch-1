/**
 * Historical FIR CSV Ingestion Script
 *
 * Bulk-imports historical First Information Reports (FIRs) from CSV files
 * into the Citizenwatch database as Report records with dataSource: HISTORICAL.
 *
 * Usage:
 *   npx ts-node scripts/ingest-fir-csv.ts [path-to-csv]
 *
 * If no path is given, it defaults to scripts/sample-fir-data.csv.
 */

import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── CSV parsing (no external deps) ─────────────────────────────────

function parseCSV(content: string): Record<string, string>[] {
    const lines = content.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim());
    const rows: Record<string, string>[] = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map((v) => v.trim());
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[j] || '';
        }
        rows.push(row);
    }

    return rows;
}

// ── Crime type mapping ─────────────────────────────────────────────

const VALID_TYPES = ['ARMED_ROBBERY', 'VEHICLE_CRIME', 'VANDALISM', 'ASSAULT', 'THEFT', 'OTHER'];

function mapCrimeType(raw: string): string {
    const upper = raw.toUpperCase().replace(/\s+/g, '_');
    if (VALID_TYPES.includes(upper)) return upper;

    // Fuzzy mapping
    if (upper.includes('ROBBERY') || upper.includes('DACOITY')) return 'ARMED_ROBBERY';
    if (upper.includes('VEHICLE') || upper.includes('CAR') || upper.includes('MOTOR')) return 'VEHICLE_CRIME';
    if (upper.includes('VANDAL') || upper.includes('DAMAGE')) return 'VANDALISM';
    if (upper.includes('ASSAULT') || upper.includes('FIGHT') || upper.includes('VIOLENCE')) return 'ASSAULT';
    if (upper.includes('THEFT') || upper.includes('SNATCH') || upper.includes('STEAL') || upper.includes('PICK')) return 'THEFT';
    return 'OTHER';
}

// ── Severity heuristic ─────────────────────────────────────────────

function heuristicSeverity(type: string): number {
    switch (type) {
        case 'ARMED_ROBBERY': return 8;
        case 'ASSAULT': return 7;
        case 'VEHICLE_CRIME': return 5;
        case 'THEFT': return 4;
        case 'VANDALISM': return 3;
        default: return 4;
    }
}

// ── Main ingestion logic ───────────────────────────────────────────

async function ingest(csvPath: string) {
    console.log(`\n📂 Reading CSV: ${csvPath}\n`);

    if (!fs.existsSync(csvPath)) {
        console.error(`❌ File not found: ${csvPath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const rows = parseCSV(content);

    console.log(`📊 Found ${rows.length} rows\n`);

    // Ensure a system user for historical imports
    let systemUser = await prisma.user.findFirst({ where: { email: 'system@citizenwatch.internal' } });
    if (!systemUser) {
        const bcrypt = await import('bcryptjs');
        systemUser = await prisma.user.create({
            data: {
                email: 'system@citizenwatch.internal',
                password: await bcrypt.hash('system', 10),
                role: 'ADMIN',
            },
        });
        console.log('👤 Created system user for historical imports\n');
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const firNumber = row.fir_number || row.firNumber || row.FIR || '';
        const description = row.description || row.Description || '';
        const type = mapCrimeType(row.crime_type || row.crimeType || row.type || 'OTHER');
        const latitude = parseFloat(row.latitude || row.lat || '0');
        const longitude = parseFloat(row.longitude || row.lng || row.lon || '0');
        const date = row.date || row.Date || '';
        const policeStation = row.police_station || row.policeStation || '';
        const district = row.district || row.District || '';

        // Validate
        if (isNaN(latitude) || isNaN(longitude) || latitude === 0 || longitude === 0) {
            console.warn(`  ⚠️  Row ${i + 1}: Invalid coordinates — skipping`);
            skipped++;
            continue;
        }

        // Check for duplicate FIR number
        if (firNumber) {
            const existing = await prisma.report.findFirst({
                where: { firNumber },
            });
            if (existing) {
                console.log(`  ⏭️  Row ${i + 1}: FIR ${firNumber} already exists — skipping`);
                skipped++;
                continue;
            }
        }

        const title = firNumber
            ? `Historical FIR ${firNumber} — ${type.replace(/_/g, ' ')}`
            : `Historical ${type.replace(/_/g, ' ')} — ${district || 'Unknown'}`;

        const fullDescription = [
            description,
            policeStation ? `Police Station: ${policeStation}` : '',
            district ? `District: ${district}` : '',
            date ? `Date: ${date}` : '',
        ].filter(Boolean).join('\n');

        try {
            await prisma.report.create({
                data: {
                    title,
                    description: fullDescription,
                    type,
                    latitude,
                    longitude,
                    status: 'VERIFIED',
                    severity: heuristicSeverity(type),
                    severityConfidence: 0.6, // heuristic, lower confidence
                    dataSource: 'HISTORICAL',
                    firNumber: firNumber || null,
                    authorId: systemUser.id,
                    createdAt: date ? new Date(date) : new Date(),
                },
            });

            imported++;
            const progress = Math.round(((i + 1) / rows.length) * 100);
            process.stdout.write(`\r  ✅ Imported ${imported}/${rows.length} (${progress}%)`);
        } catch (err: any) {
            errors++;
            console.error(`\n  ❌ Row ${i + 1}: ${err?.message}`);
        }
    }

    console.log(`\n\n📈 Ingestion complete:`);
    console.log(`   ✅ Imported: ${imported}`);
    console.log(`   ⏭️  Skipped:  ${skipped}`);
    console.log(`   ❌ Errors:   ${errors}`);
    console.log(`   📊 Total:    ${rows.length}\n`);
}

// ── Run ────────────────────────────────────────────────────────────

const csvArg = process.argv[2];
const csvPath = csvArg
    ? path.resolve(csvArg)
    : path.join(__dirname, 'sample-fir-data.csv');

ingest(csvPath)
    .then(() => prisma.$disconnect())
    .catch((e) => {
        console.error(e);
        prisma.$disconnect();
        process.exit(1);
    });
