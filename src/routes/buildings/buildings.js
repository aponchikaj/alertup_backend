import express from 'express'
import upload from '../../middlewares/upload.js'
import whoami from '../../middlewares/whoami.js'
import QRCode from 'qrcode'
import USERS from '../../models/user.model.js'
import BUILDINGS from '../../models/building.model.js'
import { Filter } from 'bad-words'

const router = express.Router()

// checking building name / checking user premium settings which checks max buildings and max floors in buildings.

const checkBuildingName = async (userID, buildingName, buildingId = null) => {
  if (!userID || !buildingName) return "Something went wrong.";

  buildingName = buildingName.trim();

  if (buildingName.length < 4 || buildingName.length > 40) {
    return "Building name must have from 4 to 40 characters";
  }

  const filter = new Filter();
  if (filter.isProfane(buildingName)) {
    return "Building name contains bad words.";
  }

  const query = {
    owner: userID,
    buildingName
  };

  if (buildingId) {
    query._id = { $ne: buildingId }; // exclude current building
  }

  const exists = await BUILDINGS.findOne(query);
  if (exists) return "Building name already exists in your buildings.";

  return true;
};


const checkPremiumSettings = async (userPremiumSettings) => {
  if (!userPremiumSettings) {
    return { Success: false, Message: "Invalid premium settings." };
  }

  if (!userPremiumSettings.hasPremium) {
    return { Success: false, Message: "You can't create more with your plan." };
  }

  const plans = {
    basic: { floors: 5, buildings: 3 },
    platinum: { floors: 8, buildings: 6 },
    elite: { floors: 12, buildings: 9 },
    professional: { floors: 30, buildings: 15 }
  };

  const plan = plans[userPremiumSettings.premiumType];
  if (!plan) {
    return { Success: false, Message: "Invalid premium type." };
  }

  return { Success: true, Message: plan };
};

router.post('/api/building/new', whoami, upload.array('maps'), async (req, res) => {
  try {
    const USER = await USERS.findById(req.user._id)
    if (!USER) return res.send({ Success: false, Message: 'User not found.' })

    const { buildingName, floors, floorNames } = req.body

    const checkingBuildingName = await checkBuildingName(USER._id,buildingName) 

    if(checkingBuildingName !== true){
      return res.send({Success:false,Message:checkingBuildingName})
    }

    const files = req.files || []

    const MAPS = []
    for (let i = 0; i < floorNames.length; i++) {
      const file = files[i] ? files[i].path : null
      const qr = await QRCode.toDataURL(
        `${process.env.CLIENT_SCAN_QR_URL}?building=${encodeURIComponent(buildingName)}&floor=${encodeURIComponent(floorNames[i])}`
      );

      MAPS.push({
        floor: floorNames[i],
        map: file,
        qrCode: qr,
        createdAt: Date.now(),
        scanned: []
      })
    }

    if(USER.verified == false){
      return res.send({Success:false,Message:"Not verified."})
    }

    let user_max_floors = 3
    let user_max_buildings = 1

    const checkingPremiumSettings = await checkPremiumSettings(USER.premium);
    if(checkingPremiumSettings.Success == false){
      return res.send({Success:false,Message:checkingPremiumSettings.Message})
    }else{
      user_max_floors = checkingPremiumSettings.Message.floors
      user_max_buildings = checkingPremiumSettings.Message.buildings
    }

    if (!Array.isArray(floorNames) || floorNames.length === 0) {
      return res.send({ Success: false, Message: "Invalid floor names." });
    }

    if (MAPS.length > user_max_floors) {
      return res.send({
        Success: false,
        Message: `You can't create more than ${user_max_floors} floors with your plan.`
      });
    }

    if(USER.Buildings.length >= user_max_buildings){
      return res.send({Success:false,Message:`You can't create more than  ${user_max_buildings} buildings with your plan.`})
    }

    const NEW_BUILDING = await BUILDINGS({
      buildingName,
      owner: USER._id,
      floors,
      maps: MAPS,
      globalScans: [],
      updatedAt: Date.now()
    })
    
    await NEW_BUILDING.save()

    await USERS.findByIdAndUpdate(USER._id, {
      $push: { Buildings: NEW_BUILDING._id }
    })

    return res.send({
      Success: true,
      Message: "Successfully created new building."
    })
  } catch (err) {
    return res.send({ Success: false, Message: 'Error.' })
  }
})

router.put('/api/building/:id',whoami,upload.array('maps'),async(req,res)=>{
  const id = req.params.id;
  const {buildingName, maps} = req.body;

  try{

    if(!id){
      return res.send({Success:false,Message:'Invalid building id.'})
    }

    const user = await USERS.findById(req.user._id);
    const building = await BUILDINGS.findById(id)

    if(!user || !building){
      return res.send({Success:false,Message:'Something went wrong.'})
    }

    if(building.owner.toString() !== user._id){
      return res.send({Success:false,Message:"You can't edit this building."})
    }

    const { buildingName, floorNames } = req.body

    const checkingBuildingName = await checkBuildingName(user._id,buildingName)
    if(checkingBuildingName !== true){
      return res.send({Success:false,Message:checkingBuildingName})
    }

    const files = req.files || []

    const MAPS = []
    for (let i = 0; i < floorNames.length; i++) {
      const file = files[i] ? files[i].path : null
      const qr = await QRCode.toDataURL(
        `${process.env.CLIENT_SCAN_QR_URL}?building=${encodeURIComponent(buildingName)}&floor=${encodeURIComponent(floorNames[i])}`
      );


      MAPS.push({
        floor: floorNames[i],
        map: file,
        qrCode: qr,
        createdAt: Date.now(),
        scanned: []
      })
    }

    let user_max_floors = 3

    const checkingPremiumSettings = await checkPremiumSettings(USER.premium);
    if(checkingPremiumSettings.Success == false){
      return res.send({Success:false,Message:checkingPremiumSettings.Message})
    }else{
      user_max_floors = checkingPremiumSettings.Message.floors
    }
    
    if (!Array.isArray(floorNames) || floorNames.length === 0) {
      return res.send({ Success: false, Message: "Invalid floor names." });
    }

    if (MAPS.length > user_max_floors) {
      return res.send({
        Success: false,
        Message: `You can't create more than ${user_max_floors} floors with your plan.`
      });
    }

    await BUILDINGS.findOneAndUpdate(
      {_id:building._id},
      {
        buildingName:buildingName,
        maps:MAPS,
        updatedAt: Date.now()
      },
      {new:true}
    )

    return res.send({Success:true,Message:'Updated.'})

  }catch{
    return res.send({Success:false,Message:'Server error.'})
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

router.post('/api/building/scan/:id/:floor', async (req, res) => {
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
