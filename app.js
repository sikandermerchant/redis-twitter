const express = require('express')
const path = require('path')
const redis = require('redis')
const bcrypt = require('bcrypt')
//To manage sessions we use the express-session library and then require it
const session = require('express-session') 
const client = redis.createClient()
const { promisify } = require('util')
const { formatDistance } = require('date-fns')

//Set-up express server
const app = express();

//Session data needs to be stored somewhere. Since we already use Redis, it’s a good choice.
// We need to install the connect-redis npm library:
// and we initialize it with this line:
const RedisStore = require('connect-redis')(session)

//Before we can receive the data, we must add a middleware to Express, 
//so it knows it has to process the URL-encoded data sent by the form.
app.use(express.urlencoded({ extended: true }))
////we add the Redis store as a middleware to Express, with app.use(). This is the code we need to initialize our session.
//Note the secret is a random value. You use a unique value, like a password, and the application will use it to verify the sessions.
//We set the session cookies to be unsecure (otherwise they will not work locally), and we set them to expire in 600 minutes(36000000 seconds). The secret value is a unique value.
////Session data is stored on server-side in Redis, and when a session is initialized a cookie is automatically sent to the client, and sent in automatically, upon every further request by the user.We’ll store the user id in the session, so we know who are we talking to.
app.use(
  session({
    store: new RedisStore({ client: client }),
    resave: true,
    saveUninitialized: true,
    cookie: {
      maxAge: 36000000,
      httpOnly: false,
      secure: false,
    },
    secret: 'bM80SARMxlq4fiWhulfNSeUFURWLTY8vyf',
  })
)
////Define Paths for Express Config and Setup express to use pug templating engine 
app.set('view engine', 'pug')
app.set('views', path.join(__dirname, '/templates/views'))

//create redis functions to resolve the call back hell using promisify
const ahget = promisify(client.hget).bind(client)
const asmembers = promisify(client.smembers).bind(client)
const ahkeys = promisify(client.hkeys).bind(client)
const aincr = promisify(client.incr).bind(client)
const alrange = promisify(client.lrange).bind(client)

//Dashboard Page and Login Page Route - Depending on user authentication
app.get('/', async (req, res) => {
  if (req.session.userid) {
     // We’re first going to load the current user name, then the names of who you follow, and we filter that from the users array we pass to the template.
     const currentUserName = await ahget(`user:${req.session.userid}`, 'username')
     const following = await asmembers(`following:${currentUserName}`)    
     const users = await ahkeys('users')
    // the below code can be improved by using async/await(already declared functions above)
        // code without async await and with call back hell
//     client.hget(
//       `user:${req.session.userid}`,
//       "username",
//       (err, currentUserName) => {
//         client.smembers(`following:${currentUserName}`, (err, following) => {
//           //We get the users array directly from Redis, calling hkeys on the users hash.
//           client.hkeys("users", (err, users) => {
//             res.render("dashboard", {
//               users:users.filter(
//                 (user) =>
//                 user !== currentUserName && following.indexOf(user) === -1
//               ),
//             })
//           })
//         })
//       }
//     )
    
    //we then get the list of posts and we’ll pass it to Pug.
  // We construct a timeline array by looking at the user’s timeline
    const timeline = []
    const posts = await alrange(`timeline:${currentUserName}`, 0, 100)
    //and for each post we construct an object containing :
  // the message, the author username and a timestamp.
    for (post of posts) {
      // The timestamp is a string containing a relative time reference.
      const timestamp = await ahget(`post:${post}`, 'timestamp')
      //We use the data-fns library to generate strings like “10 minutes ago” from a UNIX timestamp, which is the number of seconds passed since Jan 1 1970 (what we store in Redis).
      const timeString = formatDistance(
        new Date(),
        new Date(parseInt(timestamp))
      )
      // constructing an object containing the message, the author username and a timestamp.
      timeline.push({
        message: await ahget(`post:${post}`, 'message'),
        author: await ahget(`post:${post}`, 'username'),
        timeString: timeString,
      })
    }

    res.render('dashboard', {
      users: users.filter(
        (user) => user !== currentUserName && following.indexOf(user) === -1
      ),
      currentUserName,
      timeline
    })
  } else {
    res.render('login')
  }
})

//Route to render for post page by GET
app.get('/post', (req, res) => {
  if (req.session.userid) {
    res.render('post')
  } else {
    res.render('login')
  }
})
//Route to post a message from the post page by POST
app.post('/post', async (req, res) => {
  if (!req.session.userid) {
    res.render('login')
    return
  }
  const { message } = req.body
  const currentUserName = await ahget(`user:${req.session.userid}`, 'username')
  // Just like for the userid incremental number in Redis, we also have an incremental number for each post. We’ll store it in a postid key. INCR will always give us the next available post id number:
  const postid = await aincr('postid')
  // We’ll store it in a hash with the post:<postid> key and 3 fields:
  //the user id, the message content, the UNIX timestamp in the below format:
  // HSET post:<postid> userid <userid> message <message> timestamp <timestamp>
  client.hmset(`post:${postid}`, 'userid', req.session.userid, 'username', currentUserName, 'message', message, 'timestamp', Date.now())
  //we add the postid reference to a list
  client.lpush(`timeline:${currentUserName}`, postid)
 // After adding the post to our own timeline (we want to see it) we iterate over each follower, and add the post to their timeline, too.
  const followers = await asmembers(`followers:${currentUserName}`)
  for (follower of followers) {
    client.lpush(`timeline:${follower}`, postid)
  }

  res.redirect('/')
})

////let’s implement the system to track who we are following, by implementing the /follow POST endpoint
app.post('/follow', (req, res) => {
  if (!req.session.userid) {
    res.render('login')
    return
  }

  const { username } = req.body
    //we are adding two sets:
// following:<username>
// followers:<username>
// so we can keep track of who you follow, and who follows you.
  client.hget(`user:${req.session.userid}`, 'username', (err, currentUserName) => {
    client.sadd(`following:${currentUserName}`, username)
    client.sadd(`followers:${username}`, currentUserName)
  })
  // See how we call res.redirect('/') instead of res.render('dashboard'). This is because now the dashboard template needs data, and it’s simpler to just redirect to / and let that endpoint manage the data fetching rather than implement the logic in every other endpoint that has to do with showing the dashboard at the end.
  res.redirect('/')
})
//Create a POST endpoint/route for Login or Dashboard Page
app.post('/', (req, res) => {
  const { username, password } = req.body
 //Check if the username exists. 
  if (!username || !password) {
    res.render('error', { 
      message: 'Please set both username and password' 
    })
    //The return below is for stopping the app.get() function. so .log() and the rest of the function will not be executed if (true)
    return
  }
  //Check if the username exists. 
  ///Let’s create a saveSessionAndRenderDashboard function that 1) receives the user id, 2) adds it to the session data and 3)saves the session and 4)then redirects the dashboard template.
 //We call this function in both the signup and login processes after all went fine as above
  const saveSessionAndRenderDashboard = userid => {
    //1) receive the userid and 2) add to the session data
    req.session.userid = userid
    //3) Save the session
    req.session.save()
    //redirect to dashboard
    res.redirect('/')
  }
//Handle Sign-up Class
  const handleSignup = (username, password) => {
    client.incr('userid', async (err, userid) => {
      client.hset('users', username, userid)

      const saltRounds = 10
      const hash = await bcrypt.hash(password, saltRounds)

      client.hset(`user:${userid}`, 'hash', hash, 'username', username)

      saveSessionAndRenderDashboard(userid)
    })
  }
//Handle Login Class
  const handleLogin = (userid, password) => {
    client.hget(`user:${userid}`, 'hash', async (err, hash) => {
      const result = await bcrypt.compare(password, hash)
      if (result) {
        saveSessionAndRenderDashboard(userid)
      } else {
        res.render('error', {
          message: 'Incorrect password',
        })
        return
      }
    })
  }

  client.hget('users', username, (err, userid) => {
    if (!userid) { //signup procedure
      handleSignup(username, password)
    } else { //login procedure
      handleLogin(userid, password)
    }
  })
   //res.end() is needed until we dont render both success and error response through res.render, since app.get is not sending any response yet if (false), else browser will wait forever...
  // res.end();
})

app.listen(3000, () => console.log('Server ready'))