import express from 'express';
import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import {
  generateQRCodeFile,
  generateQRCodeSVGFile,
  deleteQRCodeFile,
} from '../../services/qrService.js';
import whoami from '../../middlewares/whoami.js';
import { requirePermission } from '../../middlewares/requireBuildingPermission.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { keys, keyFromUrl } from '../../services/storage.js';
import { buildScanUrl } from '../../features/qr/qrPayload.js';

const router = express.Router();

/**
 * POST /api/qr/generate
 * Generate and store the QR code image for a node.
 */
router.post(
  '/api/qr/generate',
  whoami,
  requirePermission(PERMISSIONS.CAN_EDIT_MAP),
  async (req, res) => {
    try {
      const { nodeId, buildingId, floorNumber, format = 'png' } = req.body;

      // floorNumber is checked for presence rather than truthiness: floor 0 is
      // a legitimate ground floor, so `!floorNumber` would reject it.
      if (
        !nodeId ||
        !buildingId ||
        floorNumber === undefined ||
        floorNumber === null ||
        floorNumber === ''
      ) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: nodeId, buildingId, floorNumber',
        });
      }

      if (!['png', 'svg'].includes(format)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid format. Must be "png" or "svg"',
        });
      }

      // The node must live in the caller's building, on the claimed floor.
      const node = await prisma.node.findFirst({
        where: { id: nodeId, buildingId: req.building.id },
        include: { floor: { select: { floorNumber: true } } },
      });
      if (!node) {
        return res.status(404).json({
          success: false,
          message: 'Node not found in this building',
        });
      }
      if (node.floor.floorNumber !== Number(floorNumber)) {
        return res.status(400).json({
          success: false,
          message: 'That node is not on the specified floor',
        });
      }

      // Same payload shape as every printed code already in the field.
      const qrData = buildScanUrl(
        config.urls.clientScanQr,
        req.building.id,
        node.floor.floorNumber,
        node.id
      );

      const options = {
        size: 300,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' },
        key: keys.nodeQr(req.building.id, node.id, format),
      };

      const result =
        format === 'svg'
          ? await generateQRCodeSVGFile(qrData, options)
          : await generateQRCodeFile(qrData, options);

      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to generate QR code',
          error: result.error,
        });
      }

      // Cache the slug so the node carries its own printable identity.
      await prisma.node
        .update({ where: { id: node.id }, data: { qrSlug: qrData.split('/').pop() } })
        .catch(() => {});

      res.status(200).json({
        success: true,
        message: 'QR code generated successfully',
        data: {
          qrData,
          format,
          filename: result.filename || null,
          url: result.publicUrl || result.url,
          svgContent: result.svgContent || null,
          dimensions: result.dimensions,
          size: result.size || null,
        },
      });
    } catch (error) {
      console.error('Error generating QR code:', error);
      res.status(500).json({
        success: false,
        message: 'Server error during QR code generation',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

/**
 * DELETE /api/qr/:buildingId/:qrUrl
 * Delete a QR asset belonging to a building the caller can edit.
 */
router.delete(
  '/api/qr/:buildingId/:qrUrl',
  whoami,
  requirePermission(PERMISSIONS.CAN_EDIT_MAP),
  async (req, res) => {
    try {
      const qrUrl = decodeURIComponent(req.params.qrUrl);

      // Permission over *a* building is not enough — the asset itself must sit
      // under this building's QR prefix, or any asset URL could be passed in.
      const key = keyFromUrl(qrUrl);
      const belongsToBuilding =
        key && key.startsWith(`buildings/${req.building.id}/qr/`);

      if (!belongsToBuilding) {
        return res.status(403).json({
          success: false,
          message: 'That QR code does not belong to this building',
        });
      }

      const result = await deleteQRCodeFile(qrUrl);
      if (!result.success) {
        return res.status(404).json({ success: false, message: result.message });
      }

      // Drop the reference if it was a floor-level code.
      await prisma.floor
        .updateMany({
          where: { buildingId: req.building.id, qrCodeUrl: qrUrl },
          data: { qrCodeUrl: null },
        })
        .catch(() => {});

      res.status(200).json({ success: true, message: result.message });
    } catch (error) {
      console.error('Error deleting QR code:', error);
      res.status(500).json({
        success: false,
        message: 'Server error during QR code deletion',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

export default router;
