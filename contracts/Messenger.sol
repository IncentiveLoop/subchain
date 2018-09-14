pragma solidity ^0.4.21;

contract Messenger {
  uint256 public created;

  constructor() public {
    created = block.number;
  }

  event Notify();

  function command(address to, bytes data) external {
    emit Notify();
  }
}
