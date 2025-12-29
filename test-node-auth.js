// Test node management authorization
import http from 'http';

const makeRequest = (options, data = null) => {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: body
      }));
    });
    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
};

const testNodeAuth = async () => {
  console.log('🧪 Testing Node Management Authorization\n');

  try {
    // Test 1: Try to access nodes without authentication
    console.log('📍 Test 1: Unauthorized Access');
    const unauthorizedOptions = {
      hostname: 'localhost',
      port: 3001,
      path: '/api/nodes/building/test-building-id',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const unauthorizedResponse = await makeRequest(unauthorizedOptions);
    console.log(`Status: ${unauthorizedResponse.statusCode}`);
    console.log(`Response: ${unauthorizedResponse.body}`);

    // Test 2: Try to access nodes as non-owner (without admin token)
    console.log('\n📍 Test 2: Non-Owner Access');
    const nonOwnerOptions = {
      hostname: 'localhost',
      port: 3001,
      path: '/api/nodes/building/test-building-id',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'auth-token=regular-user-token' // Regular user token
      }
    };

    const nonOwnerResponse = await makeRequest(nonOwnerOptions);
    console.log(`Status: ${nonOwnerResponse.statusCode}`);
    console.log(`Response: ${nonOwnerResponse.body}`);

    // Test 3: Try to access nodes as building owner
    console.log('\n📍 Test 3: Building Owner Access');
    const ownerOptions = {
      hostname: 'localhost',
      port: 3001,
      path: '/api/nodes/building/test-building-id',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'auth-token=building-owner-token' // Owner token
      }
    };

    const ownerResponse = await makeRequest(ownerOptions);
    console.log(`Status: ${ownerResponse.statusCode}`);
    console.log(`Response: ${ownerResponse.body}`);

    // Test 4: Try to access nodes as admin
    console.log('\n📍 Test 4: Admin Access');
    const adminOptions = {
      hostname: 'localhost',
      port: 3001,
      path: '/api/nodes/building/test-building-id',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'auth-token=admin-token;adminToken=admin-secret' // Admin token
      }
    };

    const adminResponse = await makeRequest(adminOptions);
    console.log(`Status: ${adminResponse.statusCode}`);
    console.log(`Response: ${adminResponse.body}`);

    // Test 5: Create a node as admin
    console.log('\n📍 Test 5: Create Node as Admin');
    const createOptions = {
      hostname: 'localhost',
      port: 3001,
      path: '/api/nodes',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'auth-token=admin-token;adminToken=admin-secret'
      }
    };

    const createData = {
      buildingId: 'test-building-id',
      floorNumber: 1,
      x: 100,
      y: 200,
      type: 'path',
      label: 'Test Node',
      connections: []
    };

    const createResponse = await makeRequest(createOptions, createData);
    console.log(`Status: ${createResponse.statusCode}`);
    console.log(`Response: ${createResponse.body}`);

  } catch (error) {
    console.error('❌ Test Error:', error.message);
  }
};

// Instructions for running the test
console.log('📋 Node Authorization Test Instructions:');
console.log('1. Make sure the backend server is running on localhost:3001');
console.log('2. Update the test tokens and building IDs in this script');
console.log('3. Run: node test-node-auth.js');
console.log('\nWhat to test:');
console.log('- Unauthorized users should get 401');
console.log('- Non-owners should get 403');
console.log('- Building owners should get 200');
console.log('- Admins should get 200 (with adminToken cookie)');
console.log('\nExpected behavior:');
console.log('- Only building owners OR admins can manage nodes');
console.log('- Admins need adminToken cookie to bypass ownership check');
console.log('- All requests should be properly validated');

// Uncomment to run tests (after updating tokens and IDs)
// testNodeAuth();
