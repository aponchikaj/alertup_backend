import express from 'express'
const router = express.Router()

import upload from '../../middlewares/upload.js'
import whoami from '../../middlewares/whoami.js'
import USERS from '../../models/user.model.js'
import BUILDINGS from '../../models/building.model.js'
import Filter from 'bad-words'
import bcrypt from 'bcrypt'
import sendMail from '../../services/sendEmail.js'

const checkBuildingName = (name) => {
    if (!name) return { SUCCESS: false, MESSAGE: "Invalid building name." }
    if (name.length < 4 || name.length > 40) return { SUCCESS: false, MESSAGE: "Building name must have from 4 to 40 characters." }
    const filter = new Filter()
    if (filter.isProfane(name)) return { SUCCESS: false, MESSAGE: "Building name contains forbidden words." }
    return { SUCCESS: true, MESSAGE: name }
}

const getMaxUpload = (user) => {
    if (!user.premium.hasPremium) return 3
    if (user.premium.premiumType === "basic") return 5
    if (user.premium.premiumType === "platinum") return 8
    if (user.premium.premiumType === "elite") return 12
    return 3
}

router.post('/api/buildings', whoami, upload.array('maps', 12), async (req, res) => {
    const { buildingName } = req.body

    try {
        const USER = await USERS.findById(req.user._id)
        if (!USER) return res.send({ Success: false, Message: 'Something went wrong.' })
        if (!USER.verified) return res.send({ Success: false, Message: "Verify account to create new building." })

        const checkName = checkBuildingName(buildingName)
        if (!checkName.SUCCESS) return res.send({ Success: false, Message: checkName.MESSAGE })

        const MAX = getMaxUpload(USER)
        if (req.files.length > MAX) return res.send({ Success: false, Message: "You can't upload that much maps with your plan." })

        if (!USER.premium.hasPremium && USER.Buildings.length > 2)
            return res.send({ Success: false, Message: "You can't create new building with your plan." })

        const maps = req.files.map((file, index) => ({
            floor: index + 1,
            map: file.filename,
            qrCode: '',
            createdAt: new Date().toISOString(),
            scanned: []
        }))

        const NEW_BUILDING = await BUILDINGS.create({
            maps,
            buildingName: checkName.MESSAGE,
            floors: maps.length,
            updatedAt: new Date().toISOString(),
            scanned: [],
            owner: USER._id,
            isDeactivated: false
        })

        await USERS.findByIdAndUpdate(USER._id, { $push: { Buildings: NEW_BUILDING._id } })
        await sendMail(USER.email, 'New building - AlertUp', `Hey ${USER.username}. You've created a new building.`)

        return res.send({ Success: true, Message: `Building was created successfully.` })
    } catch {
        return res.send({ Success: false, Message: "Server error." })
    }
})

router.put('/api/buildings', whoami, upload.array('maps', 12), async (req, res) => {
    const { buildingName, ID } = req.body

    try {
        if (!ID) return res.send({ Success: false, Message: "Building ID not found." })

        const building = await BUILDINGS.findById(ID)
        const user = await USERS.findById(req.user._id)

        if (!building || !user) return res.send({ Success: false, Message: "Something went wrong." })
        if (building.owner.toString() !== user._id.toString()) return res.send({ Success: false, Message: "Only owner can edit building." })

        const checkName = checkBuildingName(buildingName)
        if (!checkName.SUCCESS) return res.send({ Success: false, Message: checkName.MESSAGE })

        const MAX = getMaxUpload(user)
        if (req.files.length > MAX) return res.send({ Success: false, Message: "You can't upload that much maps with your plan." })

        const maps = req.files.map((file, index) => ({
            floor: index + 1,
            map: file.filename,
            qrCode: '',
            createdAt: new Date().toISOString(),
            scanned: []
        }))

        await BUILDINGS.findByIdAndUpdate(
            ID,
            {
                buildingName: checkName.MESSAGE,
                maps,
                updatedAt: new Date().toISOString(),
                floors: maps.length
            },
            { new: true }
        )

        return res.send({ Success: true, Message: "Saved." })
    } catch {
        return res.send({ Success: false, Message: "Server error." })
    }
})

router.put('/api/buildings/deactivate', whoami, async (req, res) => {
    const { ID, password } = req.body

    try {
        if (!ID) return res.send({ Success: false, Message: "Invalid ID." })

        const building = await BUILDINGS.findById(ID)
        const user = await USERS.findById(req.user._id)

        if (!building || !user) return res.send({ Success: false, Message: "Something went wrong." })

        const compare = await bcrypt.compare(password, user.password)
        if (!compare) return res.send({ Success: false, Message: "Invalid password." })

        if (building.owner.toString() !== user._id.toString())
            return res.send({ Success: false, Message: "Only owner can deactivate this building." })

        await BUILDINGS.findByIdAndUpdate(ID, { isDeactivated: true })
        await sendMail(user.email, 'Building Deactivation - AlertUp', `Hey ${user.username}, your building ${building.buildingName} was deactivated.`)

        return res.send({ Success: true, Message: "Building has been deactivated." })
    } catch {
        return res.send({ Success: false, Message: 'Server error.' })
    }
})

router.delete('/api/buildings', whoami, async (req, res) => {
    const { ID, password } = req.body

    try {
        if (!ID) return res.send({ Success: false, Message: "Invalid ID." })

        const building = await BUILDINGS.findById(ID)
        const user = await USERS.findById(req.user._id)

        if (!building || !user) return res.send({ Success: false, Message: "Something went wrong." })

        const compare = await bcrypt.compare(password, user.password)
        if (!compare) return res.send({ Success: false, Message: "Invalid password." })

        if (building.owner.toString() !== user._id.toString())
            return res.send({ Success: false, Message: "Only owner can delete this building." })

        await BUILDINGS.findByIdAndDelete(ID)
        await sendMail(user.email, "Building Deleted - AlertUp", `Hey ${user.username}, your building ${building.buildingName} was deleted.`)

        return res.send({ Success: true, Message: 'Deleted.' })
    } catch {
        return res.send({ Success: false, Message: "Server error." })
    }
})

router.get('/api/buildings/:id', async (req, res) => {
    const ID = req.params.id

    try {
        const building = await BUILDINGS.findById(ID)
        if (!building) return res.send({ Success: false, Message: "Building not found." })

        const author = await USERS.findById(building.owner)

        return res.send({
            Success: true,
            Message: {
                by: author.username,
                buildingName: building.buildingName,
                floors: building.floors,
                maps: building.maps,
                scanned: building.scanned.length
            }
        })
    } catch {
        return res.send({ Success: false, Message: "Server error." })
    }
})

router.get('/api/buildings/:id/:floor', async (req, res) => {
    const { id, floor } = req.params

    try {
        const building = await BUILDINGS.findById(id)
        if (!building) return res.send({ Success: false, Message: "Building not found." })

        const author = await USERS.findById(building.owner)
        const floorData = building.maps.find(m => m.floor.toString() === floor.toString())

        if (!floorData) return res.send({ Success: false, Message: "Invalid floor." })

        return res.send({
            Success: true,
            Message: {
                by: author.username,
                floor: floorData.floor,
                map: floorData.map,
                scanned: floorData.scanned.length,
                createdAt: floorData.createdAt,
                qrCode: floorData.qrCode
            }
        })
    } catch {
        return res.send({ Success: false, Message: "Server error." })
    }
})

router.get('/api/buildings/my', whoami, async (req, res) => {
    try {
        const USER = await USERS.findById(req.user._id)
        if (!USER) return res.send({ Success: false, Message: 'Something went wrong.' })

        const MY_BUILDINGS = await BUILDINGS.find({ _id: { $in: USER.Buildings } })

        return res.send({ Success: true, Message: { MyBuildings: MY_BUILDINGS } })
    } catch {
        return res.send({ Success: false, Message: 'Server error.' })
    }
})

export default router
