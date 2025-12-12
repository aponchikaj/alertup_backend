import express from 'express'
import upload from '../../middlewares/upload'
import whoami from '../../middlewares/whoami'
import QRCode from 'qrcode'
import USERS from '../../models/user.model'
import BUILDINGS from '../../models/building.model'

const router = express.Router()

router.post('/api/building/new', whoami, upload.array('maps'), async (req, res) => {
  try {
    const USER = await USERS.findById(req.user._id)
    if (!USER) return res.send({ Success: false, Message: 'User not found.' })

    const { buildingName, floors, floorNames } = req.body
    const files = req.files || []

    const MAPS = []
    for (let i = 0; i < floorNames.length; i++) {
      const file = files[i] ? files[i].path : null
      const qr = await QRCode.toDataURL(`building=${buildingName}&floor=${floorNames[i]}`)

      MAPS.push({
        floor: floorNames[i],
        map: file,
        qrCode: qr,
        createdAt: Date.now(),
        scanned: []
      })
    }

    const NEW_BUILDING = await BUILDINGS.create({
      buildingName,
      owner: USER._id,
      floors,
      maps: MAPS,
      globalScans: [],
      updatedAt: Date.now()
    })

    await USERS.findByIdAndUpdate(USER._id, {
      $push: { Buildings: NEW_BUILDING._id }
    })

    return res.send({
      Success: true,
      Message: NEW_BUILDING
    })
  } catch (err) {
    return res.send({ Success: false, Message: 'Error.' })
  }
})

router.get('/api/building/my', whoami, async (req, res) => {
  try {
    const USER = await USERS.findById(req.user._id)
    if (!USER) return res.send({ Success: false, Message: 'User not found.' })

    const BUILDINGS_LIST = await BUILDINGS.find({
      _id: { $in: USER.Buildings },
      isDeactivated: false
    })

    return res.send({
      Success: true,
      Message: BUILDINGS_LIST
    })
  } catch (err) {
    return res.send({ Success: false, Message: 'Error.' })
  }
})

router.get('/api/building/:id', whoami, async (req, res) => {
  try {
    const BUILDING = await BUILDINGS.findById(req.params.id)
    if (!BUILDING || BUILDING.isDeactivated) {
      return res.send({ Success: false, Message: 'Building not found.' })
    }

    return res.send({
      Success: true,
      Message: BUILDING
    })
  } catch (err) {
    return res.send({ Success: false, Message: 'Error.' })
  }
})

router.post('/api/building/deactivate/:id', whoami, async (req, res) => {
  try {
    const BUILDING = await BUILDINGS.findById(req.params.id)
    if (!BUILDING) return res.send({ Success: false, Message: 'Building not found.' })
    if (BUILDING.owner.toString() !== req.user._id) {
      return res.send({ Success: false, Message: 'Unauthorized.' })
    }

    BUILDING.isDeactivated = true
    BUILDING.updatedAt = Date.now()
    await BUILDING.save()

    return res.send({
      Success: true,
      Message: 'Building deactivated.'
    })
  } catch (err) {
    return res.send({ Success: false, Message: 'Error.' })
  }
})

router.delete('/api/building/delete/:id',whoami,async(req,res)=>{
    try {
        const BUILDING = await BUILDINGS.findById(req.params.id)
        if (!BUILDING) return res.send({ Success: false, Message: 'Building not found.' })
        if (BUILDING.owner.toString() !== req.user._id) {
            return res.send({ Success: false, Message: 'Unauthorized.' })
        }

        await BUILDINGS.findOneAndDelete({_id:BUILDING._id});

        return res.send({
            Success: true,
            Message: 'Building deleted.'
        })
    } catch (err) {
        return res.send({ Success: false, Message: 'Error.' })
    }
})

router.post('/api/building/scan/:id', async (req, res) => {
  try {
    const id = req.params.id
    const floorParam = req.params.floor

    const building = await BUILDINGS.findById(id)
    if (!building || building.isDeactivated) {
      return res.send({ Success: false, Message: 'Building not found.' })
    }

    const floorData = building.maps.find(f => f.floor === floorParam)
    if (!floorData) {
      return res.send({ Success: false, Message: 'Floor not found.' })
    }

    return res.send({
      Success: true,
      Message: {
        buildingName: building.buildingName,
        floor: floorData.floor,
        map: floorData.map,
        qrCode: floorData.qrCode,
        scannedCount: floorData.scanned.length,
        createdAt: floorData.createdAt
      }
    })
  } catch (err) {
    return res.send({ Success: false, Message: 'Error.' })
  }
})

export default router
