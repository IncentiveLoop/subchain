pragma solidity ^0.4.24;

contract Manager {
  address owner;

  mapping (bytes32 => bytes32) public confirmed;
  bytes32 public lastTx;

  constructor() public {
    owner = msg.sender;
  }

  function setConfirmed(bytes32 rootTxHash, bytes32 subTXHash) external {
    require(msg.sender == owner);
    confirmed[rootTxHash] = subTXHash;
    lastTx = rootTxHash;
  }
}
