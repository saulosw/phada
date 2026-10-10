import { connect } from 'node:net'

const socketPath = process.argv[2]
if (socketPath === undefined) process.exit(2)

const socket = connect(socketPath)
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('error', () => process.exit(1))
socket.on('close', () => process.exit(0))
